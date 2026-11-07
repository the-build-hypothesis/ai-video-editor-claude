import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Env } from '../env';
import { ApiError, notFound, parseInput, zodMessage } from '../errors';
import { randomId } from '../lib/crypto';
import { iso, requireUser } from '../util';
import { keys, deleteObjects } from '../storage';
import { LIMITS, type ProjectDTO, type ProjectSummaryDTO } from '../../shared/api-types';
import { ASPECT_PRESETS, ProjectSchema, SCHEMA_VERSION, createEmptyProject, projectDurationUs, type Project } from '../../shared/model';
import { MigrationError, migrateProject } from '../../shared/migrate';

export interface ProjectRow {
  id: string;
  owner_id: string;
  name: string;
  data: string;
  version: number;
  schema_version: number;
  duration_us: number;
  thumbnail_asset_id: string | null;
  size_bytes: number;
  created_at: number;
  updated_at: number;
}

export const REVISION_MIN_INTERVAL_MS = 2 * 60_000;
export const REVISION_EVERY_VERSIONS = 20;
export const REVISIONS_KEPT = 30;

const SUMMARY_COLS = 'id, owner_id, name, version, schema_version, duration_us, thumbnail_asset_id, size_bytes, created_at, updated_at';

/** First visual media clip (earliest start, then track order). */
export function thumbnailAssetId(p: Project): string | null {
  let best: { start: number; id: string } | null = null;
  for (const t of p.tracks)
    for (const c of t.clips)
      if ((c.kind === 'video' || c.kind === 'image') && (!best || c.timelineStartUs < best.start)) best = { start: c.timelineStartUs, id: c.assetId };
  return best?.id ?? null;
}

/** Whether to snapshot a revision after saving `newVersion`. */
export function shouldSnapshot(last: { version: number; created_at: number } | null, newVersion: number, now: number): boolean {
  if (!last) return true;
  return now - last.created_at >= REVISION_MIN_INTERVAL_MS || newVersion - last.version >= REVISION_EVERY_VERSIONS;
}

export function toSummary(r: Omit<ProjectRow, 'data'>): ProjectSummaryDTO {
  return {
    id: r.id,
    name: r.name,
    version: r.version,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    durationUs: r.duration_us,
    thumbnailAssetId: r.thumbnail_asset_id,
  };
}

export function toProjectDTO(r: ProjectRow): ProjectDTO {
  let data: Project;
  try {
    data = migrateProject(JSON.parse(r.data));
  } catch (e) {
    const msg = e instanceof MigrationError ? e.message : 'Stored project data is unreadable';
    throw new ApiError(500, 'project_corrupt', msg);
  }
  return { ...toSummary(r), data };
}

export async function loadOwnedProject(env: Env, id: string, ownerId: string): Promise<ProjectRow> {
  const row = await env.DB.prepare('SELECT * FROM projects WHERE id = ? AND owner_id = ?').bind(id, ownerId).first<ProjectRow>();
  if (!row) throw notFound('Project');
  return row;
}

function serialize(p: Project): string {
  const text = JSON.stringify(p);
  if (new TextEncoder().encode(text).byteLength > LIMITS.maxProjectJsonBytes)
    throw new ApiError(413, 'too_large', `Project data exceeds ${LIMITS.maxProjectJsonBytes} bytes`);
  return text;
}

function validateForWrite(data: unknown, id: string): Project {
  const r = ProjectSchema.safeParse(data);
  if (!r.success) throw new ApiError(400, 'invalid_input', 'Invalid project: ' + zodMessage(r.error));
  if (r.data.id !== id) throw new ApiError(400, 'invalid_input', 'data.id must match the project id');
  return r.data;
}

async function countProjects(env: Env, ownerId: string) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM projects WHERE owner_id = ?').bind(ownerId).first<{ n: number }>();
  return r?.n ?? 0;
}

async function insertProject(env: Env, ownerId: string, p: Project): Promise<ProjectRow> {
  if ((await countProjects(env, ownerId)) >= LIMITS.maxProjectsPerUser)
    throw new ApiError(403, 'limit_reached', `Project limit reached (${LIMITS.maxProjectsPerUser})`);
  const now = Date.now();
  const text = serialize(p);
  const row: ProjectRow = {
    id: p.id,
    owner_id: ownerId,
    name: p.name,
    data: text,
    version: 1,
    schema_version: SCHEMA_VERSION,
    duration_us: projectDurationUs(p),
    thumbnail_asset_id: thumbnailAssetId(p),
    size_bytes: text.length,
    created_at: now,
    updated_at: now,
  };
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO projects (id, owner_id, name, data, version, schema_version, duration_us, thumbnail_asset_id, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(row.id, ownerId, row.name, text, 1, SCHEMA_VERSION, row.duration_us, row.thumbnail_asset_id, row.size_bytes, now, now),
    env.DB.prepare('INSERT INTO project_revisions (project_id, version, data, created_at) VALUES (?, 1, ?, ?)').bind(row.id, text, now),
  ]);
  return row;
}

/**
 * Writes a new version if `baseVersion` still matches (atomic compare-and-set). Returns the new row
 * or null on conflict. Snapshots a revision per the retention policy.
 */
async function writeVersion(env: Env, cur: ProjectRow, p: Project, baseVersion: number, forceRevision = false): Promise<ProjectRow | null> {
  const text = serialize(p);
  const now = Date.now();
  const version = baseVersion + 1;
  const res = await env.DB.prepare(
    'UPDATE projects SET data = ?, name = ?, version = ?, schema_version = ?, duration_us = ?, thumbnail_asset_id = ?, size_bytes = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND version = ?',
  )
    .bind(text, p.name, version, SCHEMA_VERSION, projectDurationUs(p), thumbnailAssetId(p), text.length, now, cur.id, cur.owner_id, baseVersion)
    .run();
  if (!res.meta.changes) return null;
  const last = await env.DB.prepare('SELECT version, created_at FROM project_revisions WHERE project_id = ? ORDER BY version DESC LIMIT 1')
    .bind(cur.id)
    .first<{ version: number; created_at: number }>();
  if (forceRevision || shouldSnapshot(last, version, now)) {
    await env.DB.batch([
      env.DB.prepare('INSERT OR REPLACE INTO project_revisions (project_id, version, data, created_at) VALUES (?, ?, ?, ?)').bind(cur.id, version, text, now),
      env.DB.prepare(
        'DELETE FROM project_revisions WHERE project_id = ? AND id NOT IN (SELECT id FROM project_revisions WHERE project_id = ? ORDER BY version DESC LIMIT ?)',
      ).bind(cur.id, cur.id, REVISIONS_KEPT),
    ]);
  }
  return {
    ...cur,
    data: text,
    name: p.name,
    version,
    schema_version: SCHEMA_VERSION,
    duration_us: projectDurationUs(p),
    thumbnail_asset_id: thumbnailAssetId(p),
    size_bytes: text.length,
    updated_at: now,
  };
}

const IdParam = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const NameSchema = z.string().trim().min(1, 'Name is required').max(120);

export const projectRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const u = requireUser(c);
    const rs = await c.env.DB.prepare(`SELECT ${SUMMARY_COLS} FROM projects WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 500`)
      .bind(u.id)
      .all<Omit<ProjectRow, 'data'>>();
    return c.json({ projects: rs.results.map(toSummary) });
  })
  .post('/', async (c) => {
    const u = requireUser(c);
    const body = parseInput(
      z.object({
        name: NameSchema,
        aspect: z.enum(Object.keys(ASPECT_PRESETS) as [keyof typeof ASPECT_PRESETS]).optional(),
        fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]).optional(),
      }),
      await c.req.json(),
    );
    const p = createEmptyProject({ id: randomId('p'), name: body.name, aspect: body.aspect, fps: body.fps });
    const row = await insertProject(c.env, u.id, p);
    return c.json({ project: toProjectDTO(row) }, 201);
  })
  .get('/:id', async (c) => {
    const u = requireUser(c);
    const row = await loadOwnedProject(c.env, parseInput(IdParam, c.req.param('id')), u.id);
    return c.json({ project: toProjectDTO(row) });
  })
  .put('/:id', async (c) => {
    const u = requireUser(c);
    const id = parseInput(IdParam, c.req.param('id'));
    const body = parseInput(z.object({ data: z.unknown(), baseVersion: z.number().int().min(1) }), await c.req.json());
    const cur = await loadOwnedProject(c.env, id, u.id);
    const conflict = (row: ProjectRow) =>
      new ApiError(409, 'conflict', 'Project was changed elsewhere (version mismatch)', { current: toProjectDTO(row) });
    if (body.baseVersion !== cur.version) throw conflict(cur);
    const p = validateForWrite(body.data, id);
    const updated = await writeVersion(c.env, cur, p, body.baseVersion);
    if (!updated) throw conflict(await loadOwnedProject(c.env, id, u.id));
    return c.json({ project: toSummary(updated) });
  })
  .patch('/:id', async (c) => {
    const u = requireUser(c);
    const id = parseInput(IdParam, c.req.param('id'));
    const { name } = parseInput(z.object({ name: NameSchema }), await c.req.json());
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await loadOwnedProject(c.env, id, u.id);
      const p = toProjectDTO(cur).data as Project;
      const updated = await writeVersion(c.env, cur, { ...p, name }, cur.version);
      if (updated) return c.json({ project: toSummary(updated) });
    }
    throw new ApiError(409, 'conflict', 'Project is being modified concurrently, please retry');
  })
  .delete('/:id', async (c) => {
    const u = requireUser(c);
    const id = parseInput(IdParam, c.req.param('id'));
    await loadOwnedProject(c.env, id, u.id);
    const ex = await c.env.DB.prepare('SELECT id FROM exports WHERE project_id = ? AND owner_id = ?').bind(id, u.id).all<{ id: string }>();
    await deleteObjects(c.env, ex.results.map((e) => keys.exportFile(u.id, e.id)));
    await c.env.DB.prepare('DELETE FROM projects WHERE id = ? AND owner_id = ?').bind(id, u.id).run(); // cascades revisions/exports
    return c.json({ ok: true });
  })
  .post('/:id/duplicate', async (c) => {
    const u = requireUser(c);
    const cur = await loadOwnedProject(c.env, parseInput(IdParam, c.req.param('id')), u.id);
    const src = toProjectDTO(cur).data as Project;
    const name = `${src.name} (copy)`.slice(0, 120);
    const row = await insertProject(c.env, u.id, { ...src, id: randomId('p'), name });
    return c.json({ project: toSummary(row) }, 201);
  })
  .get('/:id/revisions', async (c) => {
    const u = requireUser(c);
    const cur = await loadOwnedProject(c.env, parseInput(IdParam, c.req.param('id')), u.id);
    const rs = await c.env.DB.prepare('SELECT version, created_at FROM project_revisions WHERE project_id = ? ORDER BY version DESC')
      .bind(cur.id)
      .all<{ version: number; created_at: number }>();
    return c.json({ revisions: rs.results.map((r) => ({ version: r.version, createdAt: iso(r.created_at) })) });
  })
  .post('/:id/revisions/:version/restore', async (c) => {
    const u = requireUser(c);
    const id = parseInput(IdParam, c.req.param('id'));
    const version = parseInput(z.coerce.number().int().min(1), c.req.param('version'));
    const cur = await loadOwnedProject(c.env, id, u.id);
    const rev = await c.env.DB.prepare('SELECT data FROM project_revisions WHERE project_id = ? AND version = ?').bind(id, version).first<{ data: string }>();
    if (!rev) throw notFound('Revision');
    let p: Project;
    try {
      p = migrateProject(JSON.parse(rev.data));
    } catch {
      throw new ApiError(500, 'project_corrupt', 'Revision data is unreadable');
    }
    const updated = await writeVersion(c.env, cur, { ...p, id }, cur.version, true);
    if (!updated) throw new ApiError(409, 'conflict', 'Project was changed concurrently, please retry', { current: toProjectDTO(await loadOwnedProject(c.env, id, u.id)) });
    return c.json({ project: toProjectDTO(updated) });
  });

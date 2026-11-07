import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Env } from '../env';
import { ApiError, notFound, parseInput } from '../errors';
import { randomId } from '../lib/crypto';
import { canTransition, sanitizeFilename } from '../lib/rules';
import { SNIFF_BYTES, matchesMime } from '../lib/sniff';
import { contentLength, iso, rateLimit, requireUser, serveObject } from '../util';
import { deleteObjects, keys, putVerifiedStream } from '../storage';
import { loadOwnedProject } from './projects';
import { LIMITS, type ExportDTO, type JobStatus } from '../../shared/api-types';
import { MAX_PROJECT_DURATION_US } from '../../shared/model';

export interface ExportRow {
  id: string;
  owner_id: string;
  project_id: string;
  status: JobStatus;
  progress: number;
  preset: string;
  width: number;
  height: number;
  fps: number;
  duration_us: number;
  size_bytes: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export function toExportDTO(r: ExportRow): ExportDTO {
  return {
    id: r.id,
    projectId: r.project_id,
    status: r.status,
    progress: r.progress,
    preset: r.preset,
    width: r.width,
    height: r.height,
    fps: r.fps,
    durationUs: r.duration_us,
    sizeBytes: r.size_bytes,
    error: r.error,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

async function loadOwnedExport(env: Env, id: string, ownerId: string): Promise<ExportRow> {
  const r = await env.DB.prepare('SELECT * FROM exports WHERE id = ? AND owner_id = ?').bind(id, ownerId).first<ExportRow>();
  if (!r) throw notFound('Export');
  return r;
}

const invalidTransition = (from: JobStatus, to: JobStatus) =>
  new ApiError(409, 'invalid_transition', `Export cannot go from '${from}' to '${to}'${from === 'failed' || from === 'canceled' ? '; start a new export to retry' : ''}`);

/** Compare-and-set status update; returns false if the row changed status concurrently. */
async function updateStatus(env: Env, r: ExportRow, patch: { status: JobStatus; progress?: number; error?: string | null; size?: number | null }) {
  const res = await env.DB.prepare(
    'UPDATE exports SET status = ?, progress = ?, error = ?, size_bytes = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND status = ?',
  )
    .bind(patch.status, patch.progress ?? r.progress, patch.error === undefined ? r.error : patch.error, patch.size === undefined ? r.size_bytes : patch.size, Date.now(), r.id, r.owner_id, r.status)
    .run();
  return res.meta.changes > 0;
}

const IdParam = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const exportRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const u = requireUser(c);
    const pid = c.req.query('projectId');
    const stmt = pid
      ? c.env.DB.prepare('SELECT * FROM exports WHERE owner_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT 100').bind(u.id, parseInput(IdParam, pid))
      : c.env.DB.prepare('SELECT * FROM exports WHERE owner_id = ? ORDER BY created_at DESC LIMIT 100').bind(u.id);
    const rs = await stmt.all<ExportRow>();
    return c.json({ exports: rs.results.map(toExportDTO) });
  })
  .post('/', async (c) => {
    const u = requireUser(c);
    const body = parseInput(
      z.object({
        projectId: IdParam,
        preset: z.string().trim().min(1).max(40),
        width: z.number().int().min(16).max(3840),
        height: z.number().int().min(16).max(3840),
        fps: z.number().int().min(1).max(60),
        durationUs: z.number().int().min(1).max(MAX_PROJECT_DURATION_US),
      }),
      await c.req.json(),
    );
    await loadOwnedProject(c.env, body.projectId, u.id);
    await rateLimit(c.env, `export:${u.id}`, LIMITS.exportsPerHour, 3_600_000, `Export limit reached (${LIMITS.exportsPerHour} per hour)`);
    const now = Date.now();
    const id = randomId('e');
    await c.env.DB.prepare(
      "INSERT INTO exports (id, owner_id, project_id, status, progress, preset, width, height, fps, duration_us, created_at, updated_at) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(id, u.id, body.projectId, body.preset, body.width, body.height, body.fps, body.durationUs, now, now)
      .run();
    return c.json({ export: toExportDTO(await loadOwnedExport(c.env, id, u.id)) }, 201);
  })
  .patch('/:id', async (c) => {
    const u = requireUser(c);
    const r = await loadOwnedExport(c.env, parseInput(IdParam, c.req.param('id')), u.id);
    const body = parseInput(
      z.object({
        status: z.enum(['running', 'failed', 'canceled']),
        progress: z.number().min(0).max(1).optional(),
        error: z.string().max(1000).nullable().optional(),
      }),
      await c.req.json(),
    );
    if (!canTransition(r.status, body.status)) throw invalidTransition(r.status, body.status);
    const ok = await updateStatus(c.env, r, {
      status: body.status,
      progress: body.progress,
      error: body.status === 'running' ? null : (body.error ?? (body.status === 'canceled' ? 'Canceled by user' : 'Export failed')),
    });
    if (!ok) throw new ApiError(409, 'invalid_transition', 'Export status changed concurrently');
    return c.json({ export: toExportDTO(await loadOwnedExport(c.env, r.id, u.id)) });
  })
  .put('/:id/file', async (c) => {
    const u = requireUser(c);
    const r = await loadOwnedExport(c.env, parseInput(IdParam, c.req.param('id')), u.id);
    if (!canTransition(r.status, 'completed')) throw invalidTransition(r.status, 'completed');
    const len = contentLength(c);
    if (len > LIMITS.maxExportBytes) throw new ApiError(413, 'too_large', `Export exceeds the ${Math.round(LIMITS.maxExportBytes / 1048576)} MB limit`);
    if (len < SNIFF_BYTES) throw new ApiError(415, 'invalid_media', 'Uploaded file is not an MP4');
    const body = c.req.raw.body;
    if (!body) throw new ApiError(400, 'invalid_input', 'Empty body');
    const key = keys.exportFile(u.id, r.id);
    let result: 'ok' | 'rejected';
    try {
      result = await putVerifiedStream(c.env, key, body, len, 'video/mp4', SNIFF_BYTES, (h) => matchesMime(h, 'video/mp4'));
    } catch (e) {
      await deleteObjects(c.env, [key]).catch(() => {});
      console.error(JSON.stringify({ level: 'error', msg: 'upload failed', requestId: c.get('requestId'), error: String(e).slice(0, 300) }));
      throw new ApiError(400, 'upload_failed', 'Upload failed or was interrupted; please retry');
    }
    if (result === 'rejected') throw new ApiError(415, 'invalid_media', 'Uploaded file is not an MP4 (missing ftyp box)');
    const ok = await updateStatus(c.env, r, { status: 'completed', progress: 1, error: null, size: len });
    if (!ok) {
      await deleteObjects(c.env, [key]).catch(() => {});
      throw new ApiError(409, 'invalid_transition', 'Export status changed during upload');
    }
    return c.json({ export: toExportDTO(await loadOwnedExport(c.env, r.id, u.id)) });
  })
  .get('/:id/download', async (c) => {
    const u = requireUser(c);
    const r = await loadOwnedExport(c.env, parseInput(IdParam, c.req.param('id')), u.id);
    if (r.status !== 'completed' || r.size_bytes === null) throw new ApiError(409, 'not_ready', 'Export is not completed');
    const p = await c.env.DB.prepare('SELECT name FROM projects WHERE id = ? AND owner_id = ?').bind(r.project_id, u.id).first<{ name: string }>();
    const filename = sanitizeFilename(`${p?.name ?? 'export'} ${r.height}p`, 'mp4');
    return serveObject(c, keys.exportFile(u.id, r.id), r.size_bytes, 'video/mp4', {
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
  })
  .delete('/:id', async (c) => {
    const u = requireUser(c);
    const r = await loadOwnedExport(c.env, parseInput(IdParam, c.req.param('id')), u.id);
    await deleteObjects(c.env, [keys.exportFile(u.id, r.id)]);
    await c.env.DB.prepare('DELETE FROM exports WHERE id = ? AND owner_id = ?').bind(r.id, u.id).run();
    return c.json({ ok: true });
  });

/**
 * Project schema migrations. Stored documents carry `schemaVersion`; on read we upgrade step by
 * step to SCHEMA_VERSION and validate. Unknown/newer versions are rejected rather than guessed.
 *
 * v1 (spec §5.4 illustrative shape): { schemaVersion:1, projectId, name, video:{width,height,fps},
 *     tracks:[{id,type,clips:[{id,assetId,timelineStartUs,sourceStartUs,durationUs,transform,effects}]}] }
 * v2 (current): see model.ts.
 */
import { ProjectSchema, SCHEMA_VERSION, type Project } from './model';

type Json = Record<string, unknown>;

function v1ToV2(doc: Json): Json {
  const video = (doc.video as Json) ?? {};
  const tracks = ((doc.tracks as Json[]) ?? []).map((t, i) => {
    const kind = t.type === 'audio' ? 'audio' : 'video';
    return {
      id: t.id ?? `trk${i}`,
      kind,
      name: (t.name as string) ?? `${kind === 'video' ? 'V' : 'A'}${i + 1}`,
      clips: ((t.clips as Json[]) ?? []).map((c) => ({
        id: c.id,
        kind: c.kind ?? (kind === 'audio' ? 'audio' : 'video'),
        assetId: c.assetId,
        timelineStartUs: c.timelineStartUs,
        sourceStartUs: c.sourceStartUs ?? 0,
        durationUs: c.durationUs,
        ...(c.text !== undefined ? { text: c.text } : {}),
        ...(c.transform ? { transform: c.transform } : {}),
      })),
    };
  });
  if (!tracks.some((t) => t.kind === 'audio')) tracks.push({ id: 'a1', kind: 'audio', name: 'A1', clips: [] });
  if (!tracks.some((t) => t.kind === 'video')) tracks.unshift({ id: 'v1', kind: 'video', name: 'V1', clips: [] });
  return {
    schemaVersion: 2,
    id: doc.projectId ?? doc.id,
    name: doc.name ?? 'Untitled',
    settings: { width: video.width ?? 1920, height: video.height ?? 1080, fps: video.fps ?? 30 },
    tracks,
    captions: {},
  };
}

const steps: Record<number, (d: Json) => Json> = { 1: v1ToV2 };

export class MigrationError extends Error {}

export function migrateProject(input: unknown): Project {
  if (!input || typeof input !== 'object') throw new MigrationError('Project document is not an object');
  let doc = input as Json;
  let v = Number(doc.schemaVersion);
  if (!Number.isInteger(v) || v < 1) throw new MigrationError('Missing schemaVersion');
  if (v > SCHEMA_VERSION) throw new MigrationError(`Project schema v${v} is newer than supported v${SCHEMA_VERSION}`);
  while (v < SCHEMA_VERSION) {
    const step = steps[v];
    if (!step) throw new MigrationError(`No migration from v${v}`);
    doc = step(doc);
    v = Number(doc.schemaVersion);
  }
  const r = ProjectSchema.safeParse(doc);
  if (!r.success) throw new MigrationError('Invalid project: ' + r.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

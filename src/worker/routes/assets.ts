import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Env, UserRow } from '../env';
import { ApiError, notFound, parseInput } from '../errors';
import { randomId } from '../lib/crypto';
import { SNIFF_BYTES, matchesMime } from '../lib/sniff';
import { contentLength, iso, requireUser, serveObject } from '../util';
import { deleteObjects, keys, putObject, putVerifiedStream } from '../storage';
import { ALLOWED_MIME, LIMITS, type AssetDTO, type AssetMetadata } from '../../shared/api-types';

export interface AssetRow {
  id: string;
  owner_id: string;
  name: string;
  kind: 'video' | 'image' | 'audio';
  mime_type: string;
  size_bytes: number;
  status: 'pending' | 'ready' | 'failed';
  metadata: string;
  thumb_mime: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const nnInt = z.number().int().min(0).nullable();
export const AssetMetadataSchema = z.object({
  durationUs: z.number().int().min(0).max(LIMITS.maxMediaDurationSec * 1_000_000, `Media longer than ${LIMITS.maxMediaDurationSec / 60} minutes is not supported`).nullable(),
  width: nnInt.refine((v) => v === null || v <= 16384, 'width too large'),
  height: nnInt.refine((v) => v === null || v <= 16384, 'height too large'),
  hasAudio: z.boolean(),
  peaks: z.array(z.number().min(0).max(1)).max(2000).optional(),
  hasThumbnail: z.boolean().optional(),
  fps: z.number().min(0).max(1000).nullable().optional(),
});
const PartialMetadataSchema = AssetMetadataSchema.partial();

const NameSchema = z.string().trim().min(1).max(200);
const IdParam = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const THUMB_MIME = ['image/jpeg', 'image/png', 'image/webp'];

export function quotaFor(u: Pick<UserRow, 'is_guest'>): number {
  return u.is_guest ? LIMITS.guestStorageBytes : LIMITS.userStorageBytes;
}

export function toAssetDTO(r: AssetRow): AssetDTO {
  let metadata: AssetMetadata;
  try {
    metadata = JSON.parse(r.metadata) as AssetMetadata;
  } catch {
    metadata = { durationUs: null, width: null, height: null, hasAudio: false };
  }
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes,
    status: r.status,
    metadata: { ...metadata, hasThumbnail: !!r.thumb_mime },
    createdAt: iso(r.created_at),
  };
}

export async function loadOwnedAsset(env: Env, id: string, ownerId: string): Promise<AssetRow> {
  const r = await env.DB.prepare('SELECT * FROM assets WHERE id = ? AND owner_id = ?').bind(id, ownerId).first<AssetRow>();
  if (!r) throw notFound('Asset');
  return r;
}

async function usageBytes(env: Env, ownerId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS b FROM assets WHERE owner_id = ? AND status != 'failed'")
    .bind(ownerId)
    .first<{ b: number }>();
  return r?.b ?? 0;
}

const normMime = (s: string | undefined) => (s ?? '').split(';')[0].trim().toLowerCase();

async function setStatus(env: Env, id: string, ownerId: string, status: AssetRow['status'], error: string | null) {
  await env.DB.prepare('UPDATE assets SET status = ?, error = ?, updated_at = ? WHERE id = ? AND owner_id = ?').bind(status, error, Date.now(), id, ownerId).run();
}

export const assetRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const u = requireUser(c);
    const rs = await c.env.DB.prepare('SELECT * FROM assets WHERE owner_id = ? ORDER BY created_at DESC LIMIT 1000').bind(u.id).all<AssetRow>();
    return c.json({ assets: rs.results.map(toAssetDTO), usage: { bytes: await usageBytes(c.env, u.id), limitBytes: quotaFor(u) } });
  })
  .post('/', async (c) => {
    const u = requireUser(c);
    const body = parseInput(
      z.object({
        name: NameSchema,
        kind: z.enum(['video', 'image', 'audio']),
        mimeType: z.string().max(100).transform((s) => s.toLowerCase()),
        sizeBytes: z.number().int().min(1),
        metadata: AssetMetadataSchema,
      }),
      await c.req.json(),
    );
    const kind = ALLOWED_MIME[body.mimeType];
    if (!kind) throw new ApiError(415, 'unsupported_media_type', 'Unsupported file type. Use MP4 (H.264) video, JPEG/PNG images, or MP3/WAV audio.');
    if (kind !== body.kind) throw new ApiError(400, 'invalid_input', `kind '${body.kind}' does not match MIME type ${body.mimeType}`);
    if (body.sizeBytes > LIMITS.maxAssetBytes)
      throw new ApiError(413, 'too_large', `File exceeds the ${Math.round(LIMITS.maxAssetBytes / 1048576)} MB upload limit`);
    const used = await usageBytes(c.env, u.id);
    const limit = quotaFor(u);
    if (used + body.sizeBytes > limit)
      throw new ApiError(413, 'quota_exceeded', `Storage quota exceeded (${Math.round(used / 1048576)} of ${Math.round(limit / 1048576)} MB used)`, {
        usage: { bytes: used, limitBytes: limit },
      });
    const now = Date.now();
    const id = randomId('a');
    await c.env.DB.prepare(
      "INSERT INTO assets (id, owner_id, name, kind, mime_type, size_bytes, status, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
    )
      .bind(id, u.id, body.name, kind, body.mimeType, body.sizeBytes, JSON.stringify(body.metadata), now, now)
      .run();
    return c.json({ asset: toAssetDTO((await loadOwnedAsset(c.env, id, u.id))!) }, 201);
  })
  .put('/:id/content', async (c) => {
    const u = requireUser(c);
    const a = await loadOwnedAsset(c.env, parseInput(IdParam, c.req.param('id')), u.id);
    if (a.status === 'ready') throw new ApiError(409, 'already_uploaded', 'Asset content was already uploaded');
    const len = contentLength(c);
    if (len > LIMITS.maxAssetBytes) throw new ApiError(413, 'too_large', `File exceeds the ${Math.round(LIMITS.maxAssetBytes / 1048576)} MB upload limit`);
    if (len !== a.size_bytes) throw new ApiError(400, 'size_mismatch', `Upload is ${len} bytes but the asset was declared as ${a.size_bytes} bytes`);
    const mime = normMime(c.req.header('content-type'));
    if (ALLOWED_MIME[mime] !== a.kind) throw new ApiError(415, 'unsupported_media_type', `Content-Type ${mime || '(none)'} does not match asset type ${a.mime_type}`);
    const body = c.req.raw.body;
    if (!body) throw new ApiError(400, 'invalid_input', 'Empty body');
    const key = keys.assetOriginal(u.id, a.id);
    let result: 'ok' | 'rejected';
    try {
      result = await putVerifiedStream(c.env, key, body, len, a.mime_type, SNIFF_BYTES, (head) => matchesMime(head, a.mime_type));
    } catch (e) {
      await deleteObjects(c.env, [key]).catch(() => {});
      await setStatus(c.env, a.id, u.id, 'failed', 'Upload interrupted');
      console.error(JSON.stringify({ level: 'error', msg: 'upload failed', requestId: c.get('requestId'), error: String(e).slice(0, 300) }));
      throw new ApiError(400, 'upload_failed', 'Upload failed or was interrupted; please retry');
    }
    if (result === 'rejected') {
      await deleteObjects(c.env, [key]).catch(() => {});
      await setStatus(c.env, a.id, u.id, 'failed', 'File content does not match its type');
      throw new ApiError(415, 'invalid_media', `The file content is not a valid ${a.mime_type} file (it may be corrupt or mislabeled)`);
    }
    await setStatus(c.env, a.id, u.id, 'ready', null);
    return c.json({ asset: toAssetDTO(await loadOwnedAsset(c.env, a.id, u.id)) });
  })
  .get('/:id/content', async (c) => {
    const u = requireUser(c);
    const a = await loadOwnedAsset(c.env, parseInput(IdParam, c.req.param('id')), u.id);
    if (a.status !== 'ready') throw new ApiError(409, 'not_ready', 'Asset content is not available');
    return serveObject(c, keys.assetOriginal(u.id, a.id), a.size_bytes, a.mime_type);
  })
  .put('/:id/thumbnail', async (c) => {
    const u = requireUser(c);
    const a = await loadOwnedAsset(c.env, parseInput(IdParam, c.req.param('id')), u.id);
    const mime = normMime(c.req.header('content-type'));
    if (!THUMB_MIME.includes(mime)) throw new ApiError(415, 'unsupported_media_type', 'Thumbnail must be image/jpeg, image/png or image/webp');
    const declared = Number(c.req.header('content-length') ?? '0');
    if (declared > LIMITS.maxThumbnailBytes) throw new ApiError(413, 'too_large', `Thumbnail exceeds ${LIMITS.maxThumbnailBytes / 1024} KB`);
    const buf = new Uint8Array(await c.req.arrayBuffer());
    if (buf.byteLength > LIMITS.maxThumbnailBytes) throw new ApiError(413, 'too_large', `Thumbnail exceeds ${LIMITS.maxThumbnailBytes / 1024} KB`);
    if (!matchesMime(buf.subarray(0, SNIFF_BYTES), mime)) throw new ApiError(415, 'invalid_media', 'Thumbnail content does not match its type');
    await putObject(c.env, keys.assetThumb(u.id, a.id), buf, mime);
    await c.env.DB.prepare('UPDATE assets SET thumb_mime = ?, updated_at = ? WHERE id = ? AND owner_id = ?').bind(mime, Date.now(), a.id, u.id).run();
    return c.json({ ok: true });
  })
  .get('/:id/thumbnail', async (c) => {
    const u = requireUser(c);
    const a = await loadOwnedAsset(c.env, parseInput(IdParam, c.req.param('id')), u.id);
    if (!a.thumb_mime) throw notFound('Thumbnail');
    const obj = await c.env.MEDIA.get(keys.assetThumb(u.id, a.id));
    if (!obj) throw notFound('Thumbnail');
    return new Response(obj.body, {
      headers: { 'Content-Type': a.thumb_mime, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Length': String(obj.size) },
    });
  })
  .patch('/:id', async (c) => {
    const u = requireUser(c);
    const a = await loadOwnedAsset(c.env, parseInput(IdParam, c.req.param('id')), u.id);
    const body = parseInput(z.object({ name: NameSchema.optional(), metadata: PartialMetadataSchema.optional() }), await c.req.json());
    let meta = JSON.parse(a.metadata) as AssetMetadata;
    if (body.metadata) meta = AssetMetadataSchema.parse({ ...meta, ...body.metadata });
    await c.env.DB.prepare('UPDATE assets SET name = ?, metadata = ?, updated_at = ? WHERE id = ? AND owner_id = ?')
      .bind(body.name ?? a.name, JSON.stringify(meta), Date.now(), a.id, u.id)
      .run();
    return c.json({ asset: toAssetDTO(await loadOwnedAsset(c.env, a.id, u.id)) });
  })
  .delete('/:id', async (c) => {
    const u = requireUser(c);
    const a = await loadOwnedAsset(c.env, parseInput(IdParam, c.req.param('id')), u.id);
    await deleteObjects(c.env, [keys.assetOriginal(u.id, a.id), keys.assetThumb(u.id, a.id)]);
    await c.env.DB.prepare('DELETE FROM assets WHERE id = ? AND owner_id = ?').bind(a.id, u.id).run();
    return c.json({ ok: true });
  });

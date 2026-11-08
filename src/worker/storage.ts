/**
 * Object storage access. All media/export bytes go through this module so the backend (R2 today)
 * can be swapped or given a fallback without touching routes. Keys are always derived server-side
 * from validated ids (no user-controlled path segments → no traversal).
 */
import type { Env } from './env';
import { D1BlobStore } from './d1-blob';
import { ApiError } from './errors';

/** Active object store: R2 when bound, otherwise the D1 chunked fallback. */
export function bucket(env: Env): R2Bucket {
  return (env.MEDIA ?? new D1BlobStore(env.DB)) as unknown as R2Bucket;
}
export const storageBackend = (env: Env) => (env.MEDIA ? 'r2' : 'd1');

/**
 * Capacity guard for the D1 fallback: D1 databases have a hard size limit (500 MB on the free
 * plan, 10 GB on paid). Refuse new objects with a clear message before D1 itself fails.
 * Limit is configurable via the D1_MAX_DB_MB var (default 450). No-op when R2 is bound.
 */
export async function ensureCapacity(env: Env, incomingBytes: number): Promise<void> {
  if (env.MEDIA) return;
  const limitMb = Number(env.D1_MAX_DB_MB ?? '450') || 450;
  // Logical bytes stored (SQLite reuses pages freed by deletes, so this — not the file size —
  // is what determines whether new data fits).
  // Completed objects plus chunks of multipart uploads still in progress (≤ 1 MB each).
  const r = await env.DB.prepare(
    'SELECT COALESCE((SELECT SUM(size) FROM blob_objects), 0) + 1048576 * (SELECT COUNT(*) FROM blob_chunks WHERE key NOT IN (SELECT key FROM blob_objects)) AS b',
  ).first<{ b: number }>();
  const size = Number(r?.b ?? 0);
  if (size + incomingBytes > limitMb * 1024 * 1024) {
    throw new ApiError(507, 'storage_full', 'Server media storage is full. Delete unused media or exports, or ask the administrator to enable R2 storage.');
  }
}

export const keys = {
  assetOriginal: (ownerId: string, assetId: string) => `u/${ownerId}/a/${assetId}/original`,
  assetThumb: (ownerId: string, assetId: string) => `u/${ownerId}/a/${assetId}/thumb`,
  exportFile: (ownerId: string, exportId: string) => `u/${ownerId}/e/${exportId}.mp4`,
  userPrefix: (ownerId: string) => `u/${ownerId}/`,
};

export async function putObject(env: Env, key: string, body: ReadableStream | ArrayBuffer | Uint8Array, contentType: string): Promise<number> {
  if (!(body instanceof ReadableStream)) await ensureCapacity(env, body.byteLength);
  const obj = await bucket(env).put(key, body, { httpMetadata: { contentType } });
  if (!obj) throw new Error('Storage put failed');
  return obj.size;
}

export async function getObject(env: Env, key: string, range?: { offset: number; length: number }) {
  return bucket(env).get(key, range ? { range } : undefined);
}

export async function deleteObjects(env: Env, keyList: string[]): Promise<void> {
  for (let i = 0; i < keyList.length; i += 1000) {
    const batch = keyList.slice(i, i + 1000);
    if (batch.length) await bucket(env).delete(batch);
  }
}

/** Deletes everything under a prefix (paginated). Returns the number of deleted objects. */
export async function deletePrefix(env: Env, prefix: string): Promise<number> {
  let cursor: string | undefined;
  let n = 0;
  do {
    const list = await bucket(env).list({ prefix, cursor, limit: 1000 });
    const ks = list.objects.map((o) => o.key);
    if (ks.length) await bucket(env).delete(ks);
    n += ks.length;
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return n;
}

/** Cheap liveness probe; false (never throws) when the binding is missing or erroring. */
export async function storageHealthy(env: Env): Promise<boolean> {
  try {
        await Promise.race([
      bucket(env).head('__health__'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Streams `body` into storage while verifying the first bytes with `check` before anything is
 * written. Memory use is bounded to the first chunk(s); the stream is re-wrapped in a
 * FixedLengthStream so R2 receives a known length. Returns 'rejected' if `check` fails.
 */
/**
 * Reads the first `headBytes` of a stream and runs `check`; returns a replay stream (head + rest)
 * with bounded memory, or 'rejected'.
 */
export async function verifyHead(body: ReadableStream<Uint8Array>, headBytes: number, check: (head: Uint8Array) => boolean): Promise<ReadableStream<Uint8Array> | 'rejected'> {
  const reader = body.getReader();
  const buffered: Uint8Array[] = [];
  let have = 0;
  while (have < headBytes) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value && value.byteLength) {
      buffered.push(value);
      have += value.byteLength;
    }
  }
  const head = new Uint8Array(Math.min(have, headBytes));
  let off = 0;
  for (const c of buffered) {
    if (off >= head.length) break;
    const take = c.subarray(0, head.length - off);
    head.set(take, off);
    off += take.byteLength;
  }
  if (!check(head)) {
    // Drain the remaining body (no buffering) so the client receives a clean 415 response instead
    // of a connection reset mid-upload.
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      /* client went away */
    }
    return 'rejected';
  }
  return new ReadableStream<Uint8Array>({
    pull: async (ctrl) => {
      const next = buffered.shift();
      if (next) return ctrl.enqueue(next);
      const { value, done } = await reader.read();
      if (done) ctrl.close();
      else ctrl.enqueue(value);
    },
    cancel: (r) => reader.cancel(r),
  });
}

/**
 * Streams `body` into storage while verifying the first bytes with `check` before anything is
 * written. The stream is re-wrapped in a FixedLengthStream so R2 receives a known length.
 */
export async function putVerifiedStream(
  env: Env,
  key: string,
  body: ReadableStream<Uint8Array>,
  length: number,
  contentType: string,
  headBytes: number,
  check: (head: Uint8Array) => boolean,
): Promise<'ok' | 'rejected'> {
  await ensureCapacity(env, length);
  const replay = await verifyHead(body, headBytes, check);
  if (replay === 'rejected') return 'rejected';
  const fixed = new FixedLengthStream(length);
  const pump = replay.pipeTo(fixed.writable);
  await Promise.all([putObject(env, key, fixed.readable, contentType), pump]);
  return 'ok';
}

// ------------------------------------------------------------------ multipart (large uploads)

export async function beginMultipart(env: Env, key: string, contentType: string): Promise<string> {
  if (env.MEDIA) return (await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType } })).uploadId;
  return new D1BlobStore(env.DB).beginMultipart(key);
}

export async function uploadPart(env: Env, key: string, uploadId: string, partNumber: number, partSize: number, body: ReadableStream<Uint8Array>, length: number): Promise<{ partNumber: number; etag: string }> {
  await ensureCapacity(env, length);
  const fixed = new FixedLengthStream(length);
  const pump = body.pipeTo(fixed.writable);
  if (env.MEDIA) {
    const mp = env.MEDIA.resumeMultipartUpload(key, uploadId);
    const [part] = await Promise.all([mp.uploadPart(partNumber, fixed.readable), pump]);
    return { partNumber: part.partNumber, etag: part.etag };
  }
  await Promise.all([new D1BlobStore(env.DB).putPart(key, partNumber, partSize, fixed.readable as ReadableStream<Uint8Array>), pump]);
  return { partNumber, etag: `d1-${partNumber}` };
}

export async function completeMultipart(env: Env, key: string, uploadId: string, parts: { partNumber: number; etag: string }[], contentType: string, totalSize: number): Promise<void> {
  if (env.MEDIA) {
    await env.MEDIA.resumeMultipartUpload(key, uploadId).complete(parts);
    return;
  }
  await new D1BlobStore(env.DB).completeMultipart(key, contentType, totalSize);
}

export async function abortMultipart(env: Env, key: string, uploadId: string): Promise<void> {
  if (env.MEDIA) await env.MEDIA.resumeMultipartUpload(key, uploadId).abort().catch(() => {});
  else await new D1BlobStore(env.DB).delete(key);
}

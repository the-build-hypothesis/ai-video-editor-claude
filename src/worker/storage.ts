/**
 * Object storage access. All media/export bytes go through this module so the backend (R2 today)
 * can be swapped or given a fallback without touching routes. Keys are always derived server-side
 * from validated ids (no user-controlled path segments → no traversal).
 */
import type { Env } from './env';
import { D1BlobStore } from './d1-blob';

/** Active object store: R2 when bound, otherwise the D1 chunked fallback. */
export function bucket(env: Env): R2Bucket {
  return (env.MEDIA ?? new D1BlobStore(env.DB)) as unknown as R2Bucket;
}
export const storageBackend = (env: Env) => (env.MEDIA ? 'r2' : 'd1');

export const keys = {
  assetOriginal: (ownerId: string, assetId: string) => `u/${ownerId}/a/${assetId}/original`,
  assetThumb: (ownerId: string, assetId: string) => `u/${ownerId}/a/${assetId}/thumb`,
  exportFile: (ownerId: string, exportId: string) => `u/${ownerId}/e/${exportId}.mp4`,
  userPrefix: (ownerId: string) => `u/${ownerId}/`,
};

export async function putObject(env: Env, key: string, body: ReadableStream | ArrayBuffer | Uint8Array, contentType: string): Promise<number> {
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
export async function putVerifiedStream(
  env: Env,
  key: string,
  body: ReadableStream<Uint8Array>,
  length: number,
  contentType: string,
  headBytes: number,
  check: (head: Uint8Array) => boolean,
): Promise<'ok' | 'rejected'> {
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
    await reader.cancel().catch(() => {});
    return 'rejected';
  }
  const replay = new ReadableStream<Uint8Array>({
    pull: async (ctrl) => {
      const next = buffered.shift();
      if (next) return ctrl.enqueue(next);
      const { value, done } = await reader.read();
      if (done) ctrl.close();
      else ctrl.enqueue(value);
    },
    cancel: (r) => reader.cancel(r),
  });
  const fixed = new FixedLengthStream(length);
  const pump = replay.pipeTo(fixed.writable);
  await Promise.all([putObject(env, key, fixed.readable, contentType), pump]);
  return 'ok';
}

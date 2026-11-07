/**
 * Minimal R2-compatible object store on top of D1, used when the R2 binding is unavailable
 * (e.g. R2 not enabled on the Cloudflare account). Objects are chunked into 1 MB rows.
 * Supports exactly the subset of R2Bucket used by storage.ts: put/get(range)/head/delete/list.
 * Tradeoffs (documented): D1 database size limits apply and throughput is lower than R2.
 */
export const CHUNK = 1024 * 1024;

interface Meta {
  key: string;
  size: number;
  content_type: string;
  chunk_size: number;
}

export class D1BlobStore {
  constructor(private db: D1Database) {}

  async put(key: string, body: ReadableStream | ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
    const ct = opts?.httpMetadata?.contentType ?? 'application/octet-stream';
    await this.delete(key);
    let idx = 0;
    let size = 0;
    const writeChunk = async (bytes: Uint8Array) => {
      await this.db.prepare('INSERT INTO blob_chunks (key, idx, data) VALUES (?, ?, ?)').bind(key, idx++, bytes).run();
      size += bytes.byteLength;
    };
    if (body instanceof ReadableStream) {
      const reader = (body as ReadableStream<Uint8Array>).getReader();
      let buf = new Uint8Array(CHUNK);
      let fill = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        let off = 0;
        while (off < value.byteLength) {
          const take = Math.min(CHUNK - fill, value.byteLength - off);
          buf.set(value.subarray(off, off + take), fill);
          fill += take;
          off += take;
          if (fill === CHUNK) {
            await writeChunk(buf);
            buf = new Uint8Array(CHUNK);
            fill = 0;
          }
        }
      }
      if (fill > 0) await writeChunk(buf.slice(0, fill));
    } else {
      const all = body instanceof Uint8Array ? body : new Uint8Array(body);
      for (let o = 0; o < all.byteLength; o += CHUNK) await writeChunk(all.slice(o, o + CHUNK));
    }
    await this.db
      .prepare('INSERT INTO blob_objects (key, size, content_type, chunk_size, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(key, size, ct, CHUNK, Date.now())
      .run();
    return { key, size };
  }

  async head(key: string) {
    const m = await this.db.prepare('SELECT key, size, content_type, chunk_size FROM blob_objects WHERE key = ?').bind(key).first<Meta>();
    return m ? { key: m.key, size: m.size, httpMetadata: { contentType: m.content_type } } : null;
  }

  async get(key: string, opts?: { range?: { offset: number; length: number } }) {
    const m = await this.db.prepare('SELECT key, size, content_type, chunk_size FROM blob_objects WHERE key = ?').bind(key).first<Meta>();
    if (!m) return null;
    const start = Math.max(0, opts?.range?.offset ?? 0);
    const end = Math.min(m.size, opts?.range ? start + opts.range.length : m.size); // exclusive
    const cs = m.chunk_size;
    let idx = Math.floor(start / cs);
    const last = Math.floor((Math.max(end, 1) - 1) / cs);
    const db = this.db;
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        if (idx > last || end <= start) return ctrl.close();
        const row = await db.prepare('SELECT data FROM blob_chunks WHERE key = ? AND idx = ?').bind(key, idx).first<{ data: ArrayBuffer | number[] }>();
        if (!row) return ctrl.error(new Error('missing chunk'));
        const data = row.data instanceof ArrayBuffer ? new Uint8Array(row.data) : new Uint8Array(row.data);
        const chunkStart = idx * cs;
        const s = Math.max(0, start - chunkStart);
        const e = Math.min(data.byteLength, end - chunkStart);
        ctrl.enqueue(data.subarray(s, e));
        idx++;
      },
    });
    return { key, size: m.size, body, httpMetadata: { contentType: m.content_type }, range: opts?.range };
  }

  async delete(keys: string | string[]) {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) {
      await this.db.batch([this.db.prepare('DELETE FROM blob_chunks WHERE key = ?').bind(k), this.db.prepare('DELETE FROM blob_objects WHERE key = ?').bind(k)]);
    }
  }

  async list(opts: { prefix?: string; cursor?: string; limit?: number }) {
    const limit = Math.min(1000, opts.limit ?? 1000);
    const prefix = opts.prefix ?? '';
    const after = opts.cursor ?? '';
    const r = await this.db
      .prepare('SELECT key FROM blob_objects WHERE key >= ? AND key < ? AND key > ? ORDER BY key LIMIT ?')
      .bind(prefix, prefix + '￿', after, limit + 1)
      .all<{ key: string }>();
    const rows = r.results ?? [];
    const truncated = rows.length > limit;
    const objects = rows.slice(0, limit).map((x) => ({ key: x.key }));
    return { objects, truncated, cursor: truncated ? objects[objects.length - 1].key : undefined };
  }
}

/**
 * API integration tests against the running Worker (vite dev + workerd, local D1/R2).
 * Run: npx playwright test --project=api   (requires local migrations applied)
 * Two tests make real OpenAI calls (transcription + plan); set SKIP_REAL_AI=1 to skip them.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type APIResponse } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.API_BASE_URL ?? 'http://localhost:5173';
const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(HERE, '../../fixtures');
const fixture = (n: string) => readFileSync(join(FIX, n));
const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
// A per-run client IP keeps IP-keyed rate limits from leaking between test runs (local dev only;
// Cloudflare's edge rejects requests that set this header, so it is only sent to localhost).
const randomIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

async function client(opts: { csrf?: boolean; ip?: string } = {}): Promise<APIRequestContext> {
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE);
  const headers: Record<string, string> = isLocal ? { 'CF-Connecting-IP': opts.ip ?? randomIp() } : {};
  if (opts.csrf !== false) headers['X-FF-Client'] = '1';
  return pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: headers });
}

async function json<T = any>(res: APIResponse, status = 200): Promise<T> {
  const body = await res.text();
  expect(res.status(), `${res.url()} -> ${body.slice(0, 300)}`).toBe(status);
  return JSON.parse(body) as T;
}

const PASSWORD = 'test-password-123';
const meta = (o: Partial<Record<string, unknown>> = {}) => ({ durationUs: null, width: null, height: null, hasAudio: false, ...o });

async function register(c: APIRequestContext, email: string, password = PASSWORD) {
  return json(await c.post('/api/auth/register', { data: { email, password } }));
}

async function uploadAsset(c: APIRequestContext, file: string, kind: string, mimeType: string, m = meta()) {
  const buf = fixture(file);
  const { asset } = await json(await c.post('/api/assets', { data: { name: file, kind, mimeType, sizeBytes: buf.length, metadata: m } }), 201);
  const up = await c.put(`/api/assets/${asset.id}/content`, { data: buf, headers: { 'Content-Type': mimeType } });
  return { asset, up, buf };
}

test.describe.configure({ mode: 'serial' });

let A: APIRequestContext; // registered user A
let B: APIRequestContext; // registered user B
const emailA = `a-${RUN}@example.test`;
const emailB = `b-${RUN}@example.test`;
let projectId = '';
let assetId = '';
let exportId = '';

test.beforeAll(async () => {
  A = await client();
  B = await client();
});
test.afterAll(async () => {
  await A?.dispose();
  await B?.dispose();
});

test.describe('ops', () => {
  test('health reports checks without secrets', async () => {
    const c = await client();
    const res = await c.get('/api/health');
    const h = await json(res);
    expect(h.ok).toBe(true);
    expect(h.checks).toEqual({ database: true, storage: true });
    expect(typeof h.openaiConfigured).toBe('boolean');
    expect(h.models.plan).toBeTruthy();
    expect(res.headers()['x-request-id']).toMatch(/[0-9a-f-]{36}/);
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(JSON.stringify(h)).not.toMatch(/sk-/);
  });

  test('unknown API route returns JSON 404 with requestId', async () => {
    const c = await client();
    const e = await json(await c.get('/api/nope'), 404);
    expect(e.error.code).toBe('not_found');
    expect(e.error.requestId).toBeTruthy();
  });
});

test.describe('auth', () => {
  test('register two users, me, logout, login', async () => {
    const a = await register(A, emailA.toUpperCase());
    expect(a.user).toMatchObject({ email: emailA, isGuest: false, isAdmin: false });
    const b = await register(B, emailB);
    expect(b.user.id).not.toBe(a.user.id);

    expect((await json(await A.get('/api/auth/me'))).user.email).toBe(emailA);
    await json(await A.post('/api/auth/logout'));
    expect((await json(await A.get('/api/auth/me'))).user).toBeNull();
    expect((await A.get('/api/projects')).status()).toBe(401);

    const l = await json(await A.post('/api/auth/login', { data: { email: ` ${emailA.toUpperCase()} `, password: PASSWORD } }));
    expect(l.user.id).toBe(a.user.id);
  });

  test('session cookie flags', async () => {
    const c = await client();
    const res = await c.post('/api/auth/guest');
    const sc = res.headers()['set-cookie'];
    expect(sc).toContain('ff_session=');
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    expect(sc).toMatch(/Path=\//);
    await c.dispose();
  });

  test('register validation and duplicate email', async () => {
    const c = await client();
    expect((await json(await c.post('/api/auth/register', { data: { email: 'not-an-email', password: PASSWORD } }), 400)).error.code).toBe('invalid_input');
    expect((await json(await c.post('/api/auth/register', { data: { email: `x-${RUN}@example.test`, password: 'short' } }), 400)).error.message).toMatch(/8/);
    expect((await json(await c.post('/api/auth/register', { data: { email: emailA, password: PASSWORD } }), 409)).error.code).toBe('registration_failed');
    await c.dispose();
  });

  test('wrong password gives generic error', async () => {
    const c = await client();
    const e1 = await json(await c.post('/api/auth/login', { data: { email: emailA, password: 'wrong-password' } }), 401);
    const e2 = await json(await c.post('/api/auth/login', { data: { email: `nobody-${RUN}@example.test`, password: 'wrong-password' } }), 401);
    expect(e1.error.message).toBe('Invalid email or password');
    expect(e2.error.message).toBe(e1.error.message);
    await c.dispose();
  });

  test('login is rate limited per IP+email', async () => {
    const c = await client();
    const email = `rl-${RUN}@example.test`;
    for (let i = 0; i < 10; i++) expect((await c.post('/api/auth/login', { data: { email, password: 'wrong-password' } })).status()).toBe(401);
    const res = await c.post('/api/auth/login', { data: { email, password: 'wrong-password' } });
    expect(res.status()).toBe(429);
    expect(res.headers()['retry-after']).toBeTruthy();
    // A different IP is not affected (only verifiable locally, where the client IP can be simulated).
    const other = await client();
    if (/localhost|127\.0\.0\.1/.test(BASE)) expect((await other.post('/api/auth/login', { data: { email, password: 'wrong-password' } })).status()).toBe(401);
    await c.dispose();
    await other.dispose();
  });

  test('guest flow and upgrade keeps projects', async () => {
    const g = await client();
    const { user } = await json(await g.post('/api/auth/guest'));
    expect(user).toMatchObject({ isGuest: true, email: null, isAdmin: false });
    // Idempotent while signed in.
    expect((await json(await g.post('/api/auth/guest'))).user.id).toBe(user.id);
    const { project } = await json(await g.post('/api/projects', { data: { name: 'Guest project' } }), 201);
    const up = await register(g, `guest-${RUN}@example.test`);
    expect(up.user).toMatchObject({ id: user.id, isGuest: false });
    const list = await json(await g.get('/api/projects'));
    expect(list.projects.map((p: { id: string }) => p.id)).toContain(project.id);
    await g.dispose();
  });

  test('CSRF: mutating request without X-FF-Client or JSON content type is rejected', async () => {
    const c = await client({ csrf: false });
    const res = await c.post('/api/auth/guest', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, data: 'a=1' });
    expect(res.status()).toBe(403);
    expect((await res.json()).error.code).toBe('csrf_rejected');
    await c.dispose();
  });
});

test.describe('projects', () => {
  test('CRUD, conflict, rename, duplicate, revisions, restore', async () => {
    const { project } = await json(await A.post('/api/projects', { data: { name: 'My Film', aspect: '9:16', fps: 30 } }), 201);
    projectId = project.id;
    expect(project.version).toBe(1);
    expect(project.data).toMatchObject({ id: projectId, name: 'My Film', schemaVersion: 2, settings: { width: 1080, height: 1920 } });

    const got = await json(await A.get(`/api/projects/${projectId}`));
    const data = got.project.data;
    data.tracks[0].clips.push({ id: 'txt1', kind: 'text', text: 'Hello', timelineStartUs: 0, durationUs: 2_000_000 });
    const saved = await json(await A.put(`/api/projects/${projectId}`, { data: { data, baseVersion: 1 } }));
    expect(saved.project).toMatchObject({ version: 2, durationUs: 2_000_000 });

    // Stale write → 409 conflict with current project.
    const conflict = await json(await A.put(`/api/projects/${projectId}`, { data: { data, baseVersion: 1 } }), 409);
    expect(conflict.error.code).toBe('conflict');
    expect(conflict.current.version).toBe(2);
    expect(conflict.current.data.tracks[0].clips[0].id).toBe('txt1');

    // Invalid data and mismatched id are rejected.
    expect((await json(await A.put(`/api/projects/${projectId}`, { data: { data: { ...data, tracks: [] }, baseVersion: 2 } }), 400)).error.code).toBe('invalid_input');
    expect((await json(await A.put(`/api/projects/${projectId}`, { data: { data: { ...data, id: 'other' }, baseVersion: 2 } }), 400)).error.message).toMatch(/id/);

    const renamed = await json(await A.patch(`/api/projects/${projectId}`, { data: { name: 'Renamed Film' } }));
    expect(renamed.project).toMatchObject({ name: 'Renamed Film', version: 3 });
    expect((await json(await A.get(`/api/projects/${projectId}`))).project.data.name).toBe('Renamed Film');

    const list = await json(await A.get('/api/projects'));
    expect(list.projects.find((p: { id: string }) => p.id === projectId)).toMatchObject({ name: 'Renamed Film', durationUs: 2_000_000 });

    const dup = await json(await A.post(`/api/projects/${projectId}/duplicate`), 201);
    expect(dup.project.name).toBe('Renamed Film (copy)');
    expect(dup.project.id).not.toBe(projectId);
    const dupFull = await json(await A.get(`/api/projects/${dup.project.id}`));
    expect(dupFull.project.data.id).toBe(dup.project.id);
    expect(dupFull.project.data.tracks[0].clips[0].text).toBe('Hello');

    const revs = await json(await A.get(`/api/projects/${projectId}/revisions`));
    expect(revs.revisions.map((r: { version: number }) => r.version)).toContain(1);
    const restored = await json(await A.post(`/api/projects/${projectId}/revisions/1/restore`));
    expect(restored.project.version).toBe(4);
    expect(restored.project.data.tracks[0].clips).toHaveLength(0);
    expect(restored.project.data.name).toBe('My Film');
    expect((await A.post(`/api/projects/${projectId}/revisions/99/restore`)).status()).toBe(404);

    await json(await A.delete(`/api/projects/${dup.project.id}`));
    expect((await A.get(`/api/projects/${dup.project.id}`)).status()).toBe(404);
  });

  test('input validation', async () => {
    expect((await json(await A.post('/api/projects', { data: { name: '' } }), 400)).error.code).toBe('invalid_input');
    expect((await A.post('/api/projects', { data: { name: 'x', aspect: '3:2' } })).status()).toBe(400);
    const bad = await A.post('/api/projects', { data: '{not json', headers: { 'Content-Type': 'application/json' } });
    expect(bad.status()).toBe(400);
  });
});

test.describe('assets', () => {
  test('multipart upload of a >90 MB file: parts, magic check, completion, byte-exact ranges', async () => {
    // Uses ~130 MB of storage: run locally only (the deployment's D1-fallback storage is capped).
    test.skip(!/localhost|127\.0\.0\.1/.test(BASE) && !process.env.ALLOW_LARGE_REMOTE, 'large upload test is local-only');
    test.setTimeout(240_000);
    const c = await client();
    await json(await c.post('/api/auth/guest', { data: {} }));
    const size = 130 * 1024 * 1024 + 12345;
    const buf = Buffer.alloc(size);
    // Minimal ftyp header so the magic-byte check passes; deterministic pattern elsewhere.
    Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]).copy(buf, 0);
    for (let i = 16; i < size; i += 4096) buf.writeUInt32BE(i >>> 0, i);
    const { asset } = await json(await c.post('/api/assets', { data: { name: 'big.mp4', kind: 'video', mimeType: 'video/mp4', sizeBytes: size, metadata: meta({ durationUs: 1_000_000, width: 16, height: 16 }) } }), 201);
    // Single PUT is refused above the single-request limit.
    const begin = await json(await c.post(`/api/assets/${asset.id}/multipart`, { data: {} }));
    expect(begin.partCount).toBe(3);
    // Completing early is refused.
    expect((await c.post(`/api/assets/${asset.id}/multipart/complete`, { data: {} })).status()).toBe(409);
    for (let n = 1; n <= begin.partCount; n++) {
      const part = buf.subarray((n - 1) * begin.partSize, Math.min(size, n * begin.partSize));
      await json(await c.put(`/api/assets/${asset.id}/multipart/${n}`, { data: part, headers: { 'Content-Type': 'video/mp4' } }));
    }
    const done = await json(await c.post(`/api/assets/${asset.id}/multipart/complete`, { data: {} }));
    expect(done.asset.status).toBe('ready');
    for (const [start, len] of [[0, 64], [begin.partSize - 10, 20], [2 * begin.partSize + 5, 4096], [size - 100, 100]]) {
      const r = await c.get(`/api/assets/${asset.id}/content`, { headers: { Range: `bytes=${start}-${start + len - 1}` } });
      expect(r.status()).toBe(206);
      expect(Buffer.compare(Buffer.from(await r.body()), buf.subarray(start, start + len))).toBe(0);
    }
    // Wrong magic in part 1 → rejected.
    const { asset: bad } = await json(await c.post('/api/assets', { data: { name: 'bad.mp4', kind: 'video', mimeType: 'video/mp4', sizeBytes: size, metadata: meta() } }), 201);
    await json(await c.post(`/api/assets/${bad.id}/multipart`, { data: {} }));
    const junk = Buffer.alloc(begin.partSize, 7);
    expect((await c.put(`/api/assets/${bad.id}/multipart/1`, { data: junk, headers: { 'Content-Type': 'video/mp4' } })).status()).toBe(415);
    await c.delete(`/api/assets/${asset.id}`);
    await c.delete(`/api/assets/${bad.id}`);
    await c.dispose();
  });

  test('create + upload PNG and MP3, list, range requests, thumbnail, patch', async () => {
    const png = await uploadAsset(A, 'logo.png', 'image', 'image/png', meta({ width: 64, height: 64 }));
    const pngAsset = await json(png.up);
    expect(pngAsset.asset.status).toBe('ready');

    const mp3 = await uploadAsset(A, 'music.mp3', 'audio', 'audio/mpeg', meta({ durationUs: 45_000_000, hasAudio: true, peaks: [0.1, 0.5, 1] }));
    const mp3Asset = (await json(mp3.up)).asset;
    assetId = mp3Asset.id;

    const full = await A.get(`/api/assets/${assetId}/content`);
    expect(full.status()).toBe(200);
    expect(full.headers()['content-type']).toBe('audio/mpeg');
    expect(full.headers()['accept-ranges']).toBe('bytes');
    expect(full.headers()['cache-control']).toContain('private');
    expect(Buffer.compare(await full.body(), mp3.buf)).toBe(0);

    const part = await A.get(`/api/assets/${assetId}/content`, { headers: { Range: 'bytes=100-199' } });
    expect(part.status()).toBe(206);
    expect(part.headers()['content-range']).toBe(`bytes 100-199/${mp3.buf.length}`);
    expect(Buffer.compare(await part.body(), mp3.buf.subarray(100, 200))).toBe(0);
    const tail = await A.get(`/api/assets/${assetId}/content`, { headers: { Range: 'bytes=-10' } });
    expect(tail.status()).toBe(206);
    expect(Buffer.compare(await tail.body(), mp3.buf.subarray(mp3.buf.length - 10))).toBe(0);
    expect((await A.get(`/api/assets/${assetId}/content`, { headers: { Range: `bytes=${mp3.buf.length}-` } })).status()).toBe(416);

    // Thumbnail
    await json(await A.put(`/api/assets/${pngAsset.asset.id}/thumbnail`, { data: fixture('logo.png'), headers: { 'Content-Type': 'image/png' } }));
    const th = await A.get(`/api/assets/${pngAsset.asset.id}/thumbnail`);
    expect(th.status()).toBe(200);
    expect(th.headers()['content-type']).toBe('image/png');

    const patched = await json(await A.patch(`/api/assets/${assetId}`, { data: { name: 'Song', metadata: { peaks: [0, 1] } } }));
    expect(patched.asset).toMatchObject({ name: 'Song', metadata: { durationUs: 45_000_000, hasAudio: true, peaks: [0, 1] } });
    expect((await A.patch(`/api/assets/${assetId}`, { data: { metadata: { peaks: new Array(2001).fill(0.5) } } })).status()).toBe(400);

    const list = await json(await A.get('/api/assets'));
    const ids = list.assets.map((a: { id: string }) => a.id);
    expect(ids).toEqual(expect.arrayContaining([assetId, pngAsset.asset.id]));
    expect(list.usage.bytes).toBeGreaterThanOrEqual(png.buf.length + mp3.buf.length);
    expect(list.usage.limitBytes).toBe(2 * 1024 * 1024 * 1024);
    const png2 = list.assets.find((a: { id: string }) => a.id === pngAsset.asset.id);
    expect(png2.metadata.hasThumbnail).toBe(true);

    // Delete removes content.
    await json(await A.delete(`/api/assets/${pngAsset.asset.id}`));
    expect((await A.get(`/api/assets/${pngAsset.asset.id}/content`)).status()).toBe(404);
  });

  test('rejects corrupt MP4 by magic bytes, wrong types and oversize', async () => {
    const bad = await uploadAsset(A, 'corrupt.mp4', 'video', 'video/mp4');
    const e = await json(bad.up, 415);
    expect(e.error.code).toBe('invalid_media');
    expect(e.error.message).toMatch(/not a valid video\/mp4/);
    const list = await json(await A.get('/api/assets'));
    expect(list.assets.find((a: { id: string }) => a.id === bad.asset.id).status).toBe('failed');
    expect((await A.get(`/api/assets/${bad.asset.id}/content`)).status()).toBe(409);

    // PNG bytes declared as MP3.
    const buf = fixture('logo.png');
    const { asset } = await json(await A.post('/api/assets', { data: { name: 'x.mp3', kind: 'audio', mimeType: 'audio/mpeg', sizeBytes: buf.length, metadata: meta() } }), 201);
    expect((await A.put(`/api/assets/${asset.id}/content`, { data: buf, headers: { 'Content-Type': 'audio/mpeg' } })).status()).toBe(415);

    expect((await json(await A.post('/api/assets', { data: { name: 'x.gif', kind: 'image', mimeType: 'image/gif', sizeBytes: 10, metadata: meta() } }), 415)).error.code).toBe(
      'unsupported_media_type',
    );
    expect((await A.post('/api/assets', { data: { name: 'x.png', kind: 'video', mimeType: 'image/png', sizeBytes: 10, metadata: meta() } })).status()).toBe(400);
    expect((await json(await A.post('/api/assets', { data: { name: 'big.mp4', kind: 'video', mimeType: 'video/mp4', sizeBytes: 1025 * 1024 * 1024, metadata: meta() } }), 413)).error.code).toBe('too_large');
    expect((await A.post('/api/assets', { data: { name: 'long.mp4', kind: 'video', mimeType: 'video/mp4', sizeBytes: 10, metadata: meta({ durationUs: 21 * 60 * 1e6 }) } })).status()).toBe(400);

    // Size mismatch between declared and uploaded bytes.
    const { asset: a2 } = await json(await A.post('/api/assets', { data: { name: 'l.png', kind: 'image', mimeType: 'image/png', sizeBytes: 5000, metadata: meta() } }), 201);
    expect((await json(await A.put(`/api/assets/${a2.id}/content`, { data: buf, headers: { 'Content-Type': 'image/png' } }), 400)).error.code).toBe('size_mismatch');
  });

  test('guest storage quota is enforced', async () => {
    const g = await client();
    await json(await g.post('/api/auth/guest'));
    const r = await json(await g.post('/api/assets', { data: { name: 'a.mp4', kind: 'video', mimeType: 'video/mp4', sizeBytes: 100 * 1024 * 1024, metadata: meta() } }), 201);
    expect(r.asset.status).toBe('pending');
    for (let i = 0; i < 4; i++) await json(await g.post('/api/assets', { data: { name: 'a.mp4', kind: 'video', mimeType: 'video/mp4', sizeBytes: 100 * 1024 * 1024, metadata: meta() } }), 201);
    const e = await json(await g.post('/api/assets', { data: { name: 'a.mp4', kind: 'video', mimeType: 'video/mp4', sizeBytes: 1024, metadata: meta() } }), 413);
    expect(e.error.code).toBe('quota_exceeded');
    await g.dispose();
  });
});

test.describe('exports', () => {
  test('lifecycle: create → running → upload → completed → download', async () => {
    const { export: ex } = await json(await A.post('/api/exports', { data: { projectId, preset: '720p', width: 720, height: 1280, fps: 30, durationUs: 25_000_000 } }), 201);
    exportId = ex.id;
    expect(ex).toMatchObject({ status: 'queued', progress: 0, projectId });

    // Cannot upload before running.
    expect((await json(await A.put(`/api/exports/${exportId}/file`, { data: fixture('clip-c-portrait.mp4'), headers: { 'Content-Type': 'video/mp4' } }), 409)).error.code).toBe(
      'invalid_transition',
    );
    expect((await json(await A.patch(`/api/exports/${exportId}`, { data: { status: 'running', progress: 0.1 } }))).export).toMatchObject({ status: 'running', progress: 0.1 });
    expect((await json(await A.patch(`/api/exports/${exportId}`, { data: { status: 'running', progress: 0.5 } }))).export.progress).toBe(0.5);
    // Non-MP4 bytes rejected.
    expect((await A.put(`/api/exports/${exportId}/file`, { data: fixture('corrupt.mp4'), headers: { 'Content-Type': 'video/mp4' } })).status()).toBe(415);

    const mp4 = fixture('clip-c-portrait.mp4');
    const done = await json(await A.put(`/api/exports/${exportId}/file`, { data: mp4, headers: { 'Content-Type': 'video/mp4' } }));
    expect(done.export).toMatchObject({ status: 'completed', progress: 1, sizeBytes: mp4.length });

    // Terminal: no further transitions.
    expect((await A.patch(`/api/exports/${exportId}`, { data: { status: 'failed' } })).status()).toBe(409);

    const dl = await A.get(`/api/exports/${exportId}/download`);
    expect(dl.status()).toBe(200);
    expect(dl.headers()['content-type']).toBe('video/mp4');
    expect(dl.headers()['content-disposition']).toBe('attachment; filename="My Film 1280p.mp4"');
    expect(Buffer.compare(await dl.body(), mp4)).toBe(0);
    const part = await A.get(`/api/exports/${exportId}/download`, { headers: { Range: 'bytes=4-7' } });
    expect(part.status()).toBe(206);
    expect((await part.body()).toString('latin1')).toBe('ftyp');

    const list = await json(await A.get(`/api/exports?projectId=${projectId}`));
    expect(list.exports[0].id).toBe(exportId);
  });

  test('failed/canceled jobs cannot complete; validation', async () => {
    const { export: ex } = await json(await A.post('/api/exports', { data: { projectId, preset: '1080p', width: 1080, height: 1920, fps: 30, durationUs: 1_000_000 } }), 201);
    await json(await A.patch(`/api/exports/${ex.id}`, { data: { status: 'running' } }));
    const failed = await json(await A.patch(`/api/exports/${ex.id}`, { data: { status: 'failed', error: 'Encoder crashed' } }));
    expect(failed.export).toMatchObject({ status: 'failed', error: 'Encoder crashed' });
    expect((await A.patch(`/api/exports/${ex.id}`, { data: { status: 'running' } })).status()).toBe(409);
    expect((await A.put(`/api/exports/${ex.id}/file`, { data: fixture('clip-c-portrait.mp4'), headers: { 'Content-Type': 'video/mp4' } })).status()).toBe(409);
    expect((await A.get(`/api/exports/${ex.id}/download`)).status()).toBe(409);

    const { export: ex2 } = await json(await A.post('/api/exports', { data: { projectId, preset: '720p', width: 720, height: 1280, fps: 30, durationUs: 1_000_000 } }), 201);
    expect((await json(await A.patch(`/api/exports/${ex2.id}`, { data: { status: 'canceled' } }))).export.status).toBe('canceled');
    expect((await A.patch(`/api/exports/${ex2.id}`, { data: { status: 'completed' } })).status()).toBe(400);
    expect((await A.patch(`/api/exports/${ex2.id}`, { data: { status: 'running', progress: 50 } })).status()).toBe(400);
    await json(await A.delete(`/api/exports/${ex2.id}`));

    expect((await A.post('/api/exports', { data: { projectId: 'p_doesnotexist', preset: '720p', width: 720, height: 1280, fps: 30, durationUs: 1 } })).status()).toBe(404);
    expect((await A.post('/api/exports', { data: { projectId, preset: '720p', width: 0, height: 1280, fps: 30, durationUs: 1 } })).status()).toBe(400);
  });
});

test.describe('cross-user isolation', () => {
  test("user B gets 404 on A's project, asset and export", async () => {
    expect((await B.get(`/api/projects/${projectId}`)).status()).toBe(404);
    expect((await B.put(`/api/projects/${projectId}`, { data: { data: {}, baseVersion: 1 } })).status()).toBe(404);
    expect((await B.patch(`/api/projects/${projectId}`, { data: { name: 'pwned' } })).status()).toBe(404);
    expect((await B.post(`/api/projects/${projectId}/duplicate`)).status()).toBe(404);
    expect((await B.get(`/api/projects/${projectId}/revisions`)).status()).toBe(404);
    expect((await B.post(`/api/projects/${projectId}/revisions/1/restore`)).status()).toBe(404);
    expect((await B.delete(`/api/projects/${projectId}`)).status()).toBe(404);
    expect((await json(await B.get('/api/projects'))).projects.find((p: { id: string }) => p.id === projectId)).toBeUndefined();

    expect((await B.get(`/api/assets/${assetId}/content`)).status()).toBe(404);
    expect((await B.get(`/api/assets/${assetId}/content`, { headers: { Range: 'bytes=0-10' } })).status()).toBe(404);
    expect((await B.patch(`/api/assets/${assetId}`, { data: { name: 'x' } })).status()).toBe(404);
    expect((await B.put(`/api/assets/${assetId}/content`, { data: fixture('music.mp3'), headers: { 'Content-Type': 'audio/mpeg' } })).status()).toBe(404);
    expect((await B.delete(`/api/assets/${assetId}`)).status()).toBe(404);

    expect((await B.get(`/api/exports/${exportId}/download`)).status()).toBe(404);
    expect((await B.patch(`/api/exports/${exportId}`, { data: { status: 'canceled' } })).status()).toBe(404);
    expect((await B.delete(`/api/exports/${exportId}`)).status()).toBe(404);
    expect((await json(await B.get(`/api/exports?projectId=${projectId}`))).exports).toEqual([]);
    expect((await B.post('/api/exports', { data: { projectId, preset: '720p', width: 720, height: 1280, fps: 30, durationUs: 1 } })).status()).toBe(404);

    expect((await B.post('/api/ai/plan', { data: { projectId, instruction: 'Add a title' } })).status()).toBe(404);

    // A still has everything.
    expect((await A.get(`/api/assets/${assetId}/content`)).status()).toBe(200);
    expect((await A.get(`/api/exports/${exportId}/download`)).status()).toBe(200);
  });

  test('unauthenticated requests get 401', async () => {
    const c = await client();
    expect((await c.get(`/api/projects/${projectId}`)).status()).toBe(401);
    expect((await c.get(`/api/assets/${assetId}/content`)).status()).toBe(401);
    expect((await c.get(`/api/exports/${exportId}/download`)).status()).toBe(401);
    await c.dispose();
  });
});

test.describe('admin', () => {
  test('non-admin gets 403, admin gets metrics', async () => {
    expect((await json(await A.get('/api/admin/metrics?range=24h'), 403)).error.code).toBe('forbidden');

    // Locally the allowlisted admin is registered on demand. Against a deployment the admin
    // account already exists (registered by the operator); provide ADMIN_PASSWORD to test it.
    const isLocal = /localhost|127\.0\.0\.1/.test(BASE);
    const adminPassword = process.env.ADMIN_PASSWORD ?? (isLocal ? 'admin-password-123' : '');
    test.skip(!adminPassword, 'ADMIN_PASSWORD not provided for remote admin check');
    const adm = await client();
    const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@frameforge.test';
    const reg = isLocal ? await adm.post('/api/auth/register', { data: { email: adminEmail, password: adminPassword } }) : null;
    if (!reg || reg.status() === 409) await json(await adm.post('/api/auth/login', { data: { email: adminEmail, password: adminPassword } }));
    else expect(reg.status()).toBe(200);
    expect((await json(await adm.get('/api/auth/me'))).user.isAdmin).toBe(true);

    for (const range of ['1h', '24h', '3d', '7d']) {
      const m = await json(await adm.get(`/api/admin/metrics?range=${range}`));
      expect(m.range).toBe(range);
      expect(m.users.total).toBeGreaterThanOrEqual(3);
      expect(m.users.registered).toBeGreaterThanOrEqual(3);
      expect(m.projects.total).toBeGreaterThanOrEqual(1);
      expect(m.storage.exportBytes).toBeGreaterThan(0);
      expect(typeof m.ai.costUsd).toBe('number');
    }
    expect((await adm.get('/api/admin/metrics?range=1y')).status()).toBe(400);
    await adm.dispose();
  });
});

test.describe('ai', () => {
  test('validation paths', async () => {
    expect((await json(await A.post('/api/ai/plan', { data: { projectId, instruction: '' } }), 400)).error.code).toBe('invalid_input');
    expect((await A.post('/api/ai/plan', { data: { projectId, instruction: 'x'.repeat(2001) } })).status()).toBe(400);
    expect((await A.post('/api/ai/plan', { data: { instruction: 'hi' } })).status()).toBe(400);
    expect((await A.post('/api/ai/plan', { data: { projectId: 'p_nope', instruction: 'hi' } })).status()).toBe(404);

    // Transcribe: missing file / wrong type / bad magic / unknown ids.
    expect((await A.post('/api/ai/transcribe', { multipart: { projectId, assetId, offsetSec: '0' } })).status()).toBe(400);
    const txt = { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') };
    expect((await A.post('/api/ai/transcribe', { multipart: { projectId, assetId, offsetSec: '0', file: txt } })).status()).toBe(415);
    const fakeWav = { name: 'a.wav', mimeType: 'audio/wav', buffer: Buffer.from('not really a wav file') };
    expect((await A.post('/api/ai/transcribe', { multipart: { projectId, assetId, offsetSec: '0', file: fakeWav } })).status()).toBe(415);
    const mp3 = { name: 'a.mp3', mimeType: 'audio/mpeg', buffer: fixture('music.mp3').subarray(0, 4096) };
    expect((await A.post('/api/ai/transcribe', { multipart: { projectId: 'p_nope', assetId, offsetSec: '0', file: mp3 } })).status()).toBe(404);
    expect((await A.post('/api/ai/transcribe', { multipart: { projectId, assetId: 'a_nope', offsetSec: '0', file: mp3 } })).status()).toBe(404);
    expect((await A.post('/api/ai/transcribe', { multipart: { projectId, assetId, offsetSec: '-1', file: mp3 } })).status()).toBe(400);
    expect((await B.post('/api/ai/transcribe', { multipart: { projectId, assetId, offsetSec: '0', file: mp3 } })).status()).toBe(404);
  });

  test.describe('real OpenAI calls', () => {
    test.skip(!!process.env.SKIP_REAL_AI, 'SKIP_REAL_AI set');

    test('transcription returns timed segments (real call)', async () => {
      test.setTimeout(180_000);
      const health = await json(await A.get('/api/health'));
      test.skip(!health.openaiConfigured, 'OPENAI_API_KEY not configured');
      const dir = mkdtempSync(join(tmpdir(), 'ff-wav-'));
      try {
        const wav = join(dir, 'speech.wav');
        const ffmpeg = resolve(HERE, '../../node_modules/ffmpeg-static/ffmpeg');
        execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', join(FIX, 'clip-a-speech-720p.mp4'), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
        const { asset } = await json(
          await A.post('/api/assets', { data: { name: 'speech.mp4', kind: 'video', mimeType: 'video/mp4', sizeBytes: 1, metadata: meta({ hasAudio: true }) } }),
          201,
        );
        const res = await A.post('/api/ai/transcribe', {
          multipart: { projectId, assetId: asset.id, offsetSec: '2', file: { name: 'speech.wav', mimeType: 'audio/wav', buffer: readFileSync(wav) } },
          timeout: 150_000,
        });
        const r = await json(res);
        const text = r.segments.map((s: { text: string }) => s.text).join(' ').toLowerCase();
        console.log(`[real transcription] segments=${r.segments.length} words=${r.words.length} language=${r.language} durationSec=${r.durationSec}`);
        expect(r.segments.length).toBeGreaterThan(0);
        expect(text).toMatch(/caption|fox/);
        expect(r.segments[0].startSec).toBeGreaterThanOrEqual(2); // offset applied
        expect(r.segments.at(-1).endSec).toBeLessThanOrEqual(2 + 12.7 + 0.5);
        expect(r.words.length).toBeGreaterThan(3);
        expect(r.operationId).toBeTruthy();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('plan returns validated addText op (real call)', async () => {
      test.setTimeout(150_000);
      const health = await json(await A.get('/api/health'));
      test.skip(!health.openaiConfigured, 'OPENAI_API_KEY not configured');
      const r = await json(await A.post('/api/ai/plan', { data: { projectId, instruction: "Add a title 'Hello' at the start for 3 seconds" }, timeout: 130_000 }));
      console.log(`[real plan] summary=${JSON.stringify(r.plan.summary)} ops=${JSON.stringify(r.plan.operations.map((o: Record<string, unknown>) => ({ type: o.type, text: o.text, startSec: o.startSec, durationSec: o.durationSec, position: o.position })))} unsupported=${JSON.stringify(r.plan.unsupported)}`);
      const add = r.plan.operations.find((o: { type: string }) => o.type === 'addText');
      expect(add).toBeTruthy();
      expect(add.text).toMatch(/hello/i);
      expect(add.startSec ?? 0).toBeLessThanOrEqual(0.5);
      expect(add.durationSec).toBeCloseTo(3, 0);

      const ops = await json(await A.get(`/api/ai/operations?projectId=${projectId}`));
      const planOp = ops.operations.find((o: { id: string }) => o.id === r.operationId);
      expect(planOp).toMatchObject({ kind: 'plan', status: 'completed' });
      expect(planOp.inputTokens).toBeGreaterThan(0);
      expect(planOp.costUsd).toBeGreaterThan(0);
      expect(planOp.latencyMs).toBeGreaterThan(0);
    });
  });
});

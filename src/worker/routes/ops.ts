import { Hono } from 'hono';
import { type AppEnv, APP_VERSION, planModel, transcriptionModel } from '../env';
import { ApiError } from '../errors';
import { isAdminEmail, parseAdminRange } from '../lib/rules';
import { storageHealthy } from '../storage';
import { requireUser } from '../util';
import type { AdminMetricsDTO, HealthDTO } from '../../shared/api-types';

export const opsRoutes = new Hono<AppEnv>()
  .get('/health', async (c) => {
    let database = false;
    try {
      database = (await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>())?.ok === 1;
    } catch {
      database = false;
    }
    const storage = await storageHealthy(c.env);
    const body: HealthDTO = {
      ok: database && storage,
      version: APP_VERSION,
      time: new Date().toISOString(),
      checks: { database, storage },
      openaiConfigured: Boolean(c.env.OPENAI_API_KEY),
      models: { plan: planModel(c.env), transcription: transcriptionModel(c.env) },
    };
    return c.json(body);
  })
  .get('/admin/metrics', async (c) => {
    const u = requireUser(c);
    if (!isAdminEmail(u.email, !!u.is_guest, c.env.ADMIN_EMAILS)) throw new ApiError(403, 'forbidden', 'Admin access required');
    const parsed = parseAdminRange(c.req.query('range'), Date.now());
    if (!parsed) throw new ApiError(400, 'invalid_input', 'range must be one of 1h, 24h, 3d, 7d');
    const since = parsed.sinceMs;
    const db = c.env.DB;
    type N = Record<string, number | null>;
    const [users, projects, assets, exportBytes, exportsAgg, ai, byKind] = await db.batch<N>([
      db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN is_guest = 0 THEN 1 ELSE 0 END) AS registered, SUM(is_guest) AS guests, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS newInRange FROM users').bind(since),
      db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN updated_at >= ? THEN 1 ELSE 0 END) AS updatedInRange FROM projects').bind(since),
      db.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS bytes, COUNT(*) AS n FROM assets WHERE status = 'ready'"),
      db.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM exports WHERE status = 'completed'"),
      db.prepare(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN created_at >= ?1 THEN 1 ELSE 0 END) AS inRange, SUM(CASE WHEN created_at >= ?1 AND status = 'completed' THEN 1 ELSE 0 END) AS completed, SUM(CASE WHEN created_at >= ?1 AND status = 'failed' THEN 1 ELSE 0 END) AS failed FROM exports",
      ).bind(since),
      db.prepare(
        "SELECT COUNT(*) AS calls, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed, COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(audio_seconds), 0) AS secs, COALESCE(SUM(input_tokens), 0) AS inTok, COALESCE(SUM(output_tokens), 0) AS outTok FROM ai_operations WHERE created_at >= ?",
      ).bind(since),
      db.prepare('SELECT kind, COUNT(*) AS n FROM ai_operations WHERE created_at >= ? GROUP BY kind').bind(since),
    ]);
    const one = (r: D1Result<N>) => r.results[0] ?? {};
    const n = (v: unknown) => Number(v ?? 0);
    const us = one(users), pr = one(projects), as = one(assets), eb = one(exportBytes), ex = one(exportsAgg), a = one(ai);
    const dto: AdminMetricsDTO = {
      range: parsed.range,
      since: new Date(since).toISOString(),
      users: { total: n(us.total), registered: n(us.registered), guests: n(us.guests), newInRange: n(us.newInRange) },
      projects: { total: n(pr.total), updatedInRange: n(pr.updatedInRange) },
      storage: { assetBytes: n(as.bytes), exportBytes: n(eb.bytes), assetCount: n(as.n), ...(await storageCapacity(c.env)) },
      exports: { total: n(ex.total), inRange: n(ex.inRange), completed: n(ex.completed), failed: n(ex.failed) },
      ai: {
        calls: n(a.calls),
        failed: n(a.failed),
        costUsd: Math.round(n(a.cost) * 1e6) / 1e6,
        transcribeSeconds: Math.round(n(a.secs) * 10) / 10,
        inputTokens: n(a.inTok),
        outputTokens: n(a.outTok),
        byKind: Object.fromEntries((byKind.results as unknown as { kind: string; n: number }[]).map((r) => [r.kind, r.n])),
      },
    };
    return c.json(dto);
  });

/** Object-store capacity info for the admin page (D1 fallback has a configured cap). */
async function storageCapacity(env: AppEnv['Bindings']): Promise<{ backend: 'r2' | 'd1'; capBytes: number | null; usedBytes: number | null }> {
  if (env.MEDIA) return { backend: 'r2', capBytes: null, usedBytes: null };
  const r = await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS b FROM blob_objects').first<{ b: number }>();
  return { backend: 'd1', capBytes: (Number(env.D1_MAX_DB_MB ?? '450') || 450) * 1024 * 1024, usedBytes: Number(r?.b ?? 0) };
}

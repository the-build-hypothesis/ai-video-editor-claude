/**
 * FrameForge API Worker. Static assets are served by Workers assets; this handles /api/* only.
 * See docs/API.md and src/shared/api-types.ts for the contract.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Env } from './env';
import { ApiError, zodMessage } from './errors';
import { authRoutes, sessionMiddleware } from './routes/auth';
import { projectRoutes } from './routes/projects';
import { assetRoutes } from './routes/assets';
import { exportRoutes } from './routes/exports';
import { aiRoutes } from './routes/ai';
import { opsRoutes } from './routes/ops';
import { runMaintenance } from './scheduled';
import { LIMITS } from '../shared/api-types';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Bodies above this are rejected unless the route streams/handles its own limit. */
const MAX_JSON_BODY = LIMITS.maxProjectJsonBytes + 256 * 1024;
const isUploadRoute = (method: string, path: string) =>
  (method === 'PUT' && /^\/api\/(assets\/[^/]+\/(content|thumbnail)|exports\/[^/]+\/file)$/.test(path)) || (method === 'POST' && path === '/api/ai/transcribe');

const app = new Hono<AppEnv>();

// Request id, structured access log, security headers.
app.use('*', async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  c.set('user', null);
  const t0 = Date.now();
  await next();
  const h = c.res.headers;
  h.set('X-Request-Id', requestId);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
  const status = c.res.status;
  const user = c.get('user');
  console.log(
    JSON.stringify({
      level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
      msg: 'request',
      requestId,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status,
      ms: Date.now() - t0,
      ...(user ? { userId: user.id } : {}),
    }),
  );
});

// CSRF: mutating requests must carry a header a cross-site form cannot send without CORS preflight.
app.use('/api/*', async (c, next) => {
  if (MUTATING.has(c.req.method)) {
    const ct = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (c.req.header('x-ff-client') !== '1' && ct !== 'application/json')
      throw new ApiError(403, 'csrf_rejected', 'Missing X-FF-Client header');
    const len = Number(c.req.header('content-length') ?? '0');
    if (!isUploadRoute(c.req.method, new URL(c.req.url).pathname) && len > MAX_JSON_BODY) throw new ApiError(413, 'too_large', 'Request body too large');
  }
  await next();
});

app.use('/api/*', sessionMiddleware);

app.route('/api/auth', authRoutes);
app.route('/api/projects', projectRoutes);
app.route('/api/assets', assetRoutes);
app.route('/api/exports', exportRoutes);
app.route('/api/ai', aiRoutes);
app.route('/api', opsRoutes);

app.notFound((c) =>
  c.json({ error: { code: 'not_found', message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}`, requestId: c.get('requestId') } }, 404),
);

app.onError((err, c) => {
  const requestId = c.get('requestId') ?? crypto.randomUUID();
  if (err instanceof ApiError) {
    const res = c.json({ error: { code: err.code, message: err.message, requestId }, ...(err.extra ?? {}) }, err.status);
    for (const [k, v] of Object.entries(err.headers ?? {})) res.headers.set(k, v);
    return res;
  }
  if (err instanceof z.ZodError) return c.json({ error: { code: 'invalid_input', message: zodMessage(err), requestId } }, 400);
  if (err instanceof SyntaxError) return c.json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON', requestId } }, 400);
  console.error(JSON.stringify({ level: 'error', msg: 'unhandled', requestId, error: String(err).slice(0, 500), stack: (err as Error)?.stack?.slice(0, 2000) }));
  return c.json({ error: { code: 'internal', message: 'Internal server error', requestId } }, 500);
});

export { app };

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runMaintenance(env));
  },
} satisfies ExportedHandler<Env>;

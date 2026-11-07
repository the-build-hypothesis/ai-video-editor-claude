import type { Ctx, Env, UserRow } from './env';
import { ApiError, unauthorized } from './errors';
import { isOverLimit, parseRange, retryAfterSeconds, windowStart, isAdminEmail } from './lib/rules';
import { getObject } from './storage';
import type { UserDTO } from '../shared/api-types';

export const iso = (ms: number) => new Date(ms).toISOString();

export function clientIp(c: Ctx): string {
  return c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || 'unknown';
}

export function requireUser(c: Ctx): UserRow {
  const u = c.get('user');
  if (!u) throw unauthorized();
  return u;
}

export function toUserDTO(u: UserRow, env: Env): UserDTO {
  return {
    id: u.id,
    email: u.email,
    isGuest: !!u.is_guest,
    isAdmin: isAdminEmail(u.email, !!u.is_guest, env.ADMIN_EMAILS),
    createdAt: iso(u.created_at),
  };
}

/** Fixed-window counter in D1. Throws 429 when the limit is exceeded. */
export async function rateLimit(env: Env, key: string, limit: number, windowMs: number, message = 'Too many requests, please try again later'): Promise<void> {
  const now = Date.now();
  const ws = windowStart(now, windowMs);
  const row = await env.DB.prepare(
    'INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1 RETURNING count',
  )
    .bind(key, ws)
    .first<{ count: number }>();
  if (row && isOverLimit(row.count, limit)) {
    const ra = retryAfterSeconds(now, windowMs);
    throw new ApiError(429, 'rate_limited', message, { retryAfterSec: ra }, { 'Retry-After': String(ra) });
  }
}

/** Required Content-Length (for streamed uploads). */
export function contentLength(c: Ctx): number {
  const raw = c.req.header('content-length');
  const n = raw === undefined ? NaN : Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ApiError(411, 'length_required', 'Content-Length header is required');
  return n;
}

/** Serve an object from storage with single-range support. */
export async function serveObject(c: Ctx, key: string, size: number, contentType: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const range = parseRange(c.req.header('range'), size);
  const headers = new Headers({
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    ...extraHeaders,
  });
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${size}`);
    throw new ApiError(416, 'range_not_satisfiable', 'Requested range not satisfiable', undefined, Object.fromEntries(headers));
  }
  const obj = await getObject(c.env, key, range ? { offset: range.start, length: range.end - range.start + 1 } : undefined);
  if (!obj) throw new ApiError(404, 'not_found', 'File not found in storage');
  if (range) {
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    headers.set('Content-Length', String(range.end - range.start + 1));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

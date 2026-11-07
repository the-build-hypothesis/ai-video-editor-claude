import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import type { AppEnv, Ctx, Env, UserRow } from '../env';
import { ApiError, parseInput } from '../errors';
import { DUMMY_PASSWORD_HASH, hashPassword, randomId, randomToken, sha256Hex, verifyPassword } from '../lib/crypto';
import { clientIp, rateLimit, toUserDTO } from '../util';

export const SESSION_COOKIE = 'ff_session';
const SESSION_MS = 30 * 86_400_000;
const REFRESH_AFTER_MS = 86_400_000; // extend sliding expiry at most once a day

export const LOGIN_LIMIT = { limit: 10, windowMs: 15 * 60_000 };
export const REGISTER_LIMIT = { limit: 20, windowMs: 60 * 60_000 };
export const GUEST_LIMIT = { limit: 60, windowMs: 60 * 60_000 };

const isLocalHttp = (c: Ctx) => {
  const u = new URL(c.req.url);
  return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
};

function setSessionCookie(c: Ctx, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    // Browsers treat http://localhost as a secure context, but some HTTP clients do not; only relax for local dev.
    secure: !isLocalHttp(c),
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_MS / 1000,
  });
}

async function createSession(c: Ctx, userId: string) {
  const token = randomToken(32);
  const now = Date.now();
  await c.env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, now, now + SESSION_MS)
    .run();
  setSessionCookie(c, token);
}

async function dropCurrentSession(c: Ctx) {
  const h = c.get('sessionHash');
  if (h) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(h).run();
}

/** Loads the session user (if any) into c.var.user. Never fails the request. */
export const sessionMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  c.set('user', null);
  c.set('sessionHash', null);
  const token = getCookie(c, SESSION_COOKIE);
  if (token && token.length <= 128) {
    const hash = await sha256Hex(token);
    const now = Date.now();
    const row = await c.env.DB.prepare(
      'SELECT u.*, s.expires_at AS s_expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
    )
      .bind(hash, now)
      .first<UserRow & { s_expires: number }>();
    if (row) {
      const { s_expires, ...user } = row;
      c.set('user', user);
      c.set('sessionHash', hash);
      if (s_expires - now < SESSION_MS - REFRESH_AFTER_MS) {
        await c.env.DB.batch([
          c.env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(now + SESSION_MS, hash),
          c.env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(now, user.id),
        ]);
        setSessionCookie(c, token);
      }
    }
  }
  await next();
});

const Credentials = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .pipe(z.email({ message: 'Enter a valid email address' })),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200, 'Password must be at most 200 characters'),
});

async function getUser(env: Env, id: string) {
  return env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
}

export const authRoutes = new Hono<AppEnv>()
  .get('/me', (c) => {
    const u = c.get('user');
    return c.json({ user: u ? toUserDTO(u, c.env) : null });
  })
  .post('/guest', async (c) => {
    const existing = c.get('user');
    if (existing) return c.json({ user: toUserDTO(existing, c.env) });
    await rateLimit(c.env, `guest:${clientIp(c)}`, GUEST_LIMIT.limit, GUEST_LIMIT.windowMs);
    const now = Date.now();
    const id = randomId('u');
    await c.env.DB.prepare('INSERT INTO users (id, email, password_hash, is_guest, created_at, updated_at, last_seen_at) VALUES (?, NULL, NULL, 1, ?, ?, ?)')
      .bind(id, now, now, now)
      .run();
    await createSession(c, id);
    return c.json({ user: toUserDTO((await getUser(c.env, id))!, c.env) });
  })
  .post('/register', async (c) => {
    const body = parseInput(Credentials, await c.req.json());
    await rateLimit(c.env, `register:${clientIp(c)}`, REGISTER_LIMIT.limit, REGISTER_LIMIT.windowMs, 'Too many registration attempts, please try again later');
    const taken = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(body.email).first();
    if (taken)
      throw new ApiError(409, 'registration_failed', 'Unable to register with this email address. If you already have an account, sign in instead.');
    const hash = await hashPassword(body.password);
    const now = Date.now();
    const current = c.get('user');
    let id: string;
    try {
      if (current?.is_guest) {
        // Upgrade the guest in place: keeps projects/assets/exports.
        id = current.id;
        await c.env.DB.prepare('UPDATE users SET email = ?, password_hash = ?, is_guest = 0, updated_at = ?, last_seen_at = ? WHERE id = ? AND is_guest = 1')
          .bind(body.email, hash, now, now, id)
          .run();
      } else {
        id = randomId('u');
        await c.env.DB.prepare('INSERT INTO users (id, email, password_hash, is_guest, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, 0, ?, ?, ?)')
          .bind(id, body.email, hash, now, now, now)
          .run();
      }
    } catch (e) {
      if (String(e).includes('UNIQUE')) throw new ApiError(409, 'registration_failed', 'Unable to register with this email address. If you already have an account, sign in instead.');
      throw e;
    }
    // Rotate the session (prevents fixation; guest token is replaced).
    await dropCurrentSession(c);
    await createSession(c, id);
    return c.json({ user: toUserDTO((await getUser(c.env, id))!, c.env) });
  })
  .post('/login', async (c) => {
    const raw = (await c.req.json()) as unknown;
    const r = z.object({ email: z.string().trim().toLowerCase().max(254), password: z.string().max(200) }).safeParse(raw);
    if (!r.success) throw new ApiError(400, 'invalid_input', 'Email and password are required');
    const { email, password } = r.data;
    await rateLimit(c.env, `login:${clientIp(c)}:${email}`, LOGIN_LIMIT.limit, LOGIN_LIMIT.windowMs, 'Too many sign-in attempts, please try again later');
    const user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ? AND is_guest = 0').bind(email).first<UserRow>();
    const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!user || !ok) throw new ApiError(401, 'invalid_credentials', 'Invalid email or password');
    await dropCurrentSession(c);
    await createSession(c, user.id);
    await c.env.DB.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(Date.now(), user.id).run();
    return c.json({ user: toUserDTO(user, c.env) });
  })
  .post('/logout', async (c) => {
    await dropCurrentSession(c);
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: !isLocalHttp(c) });
    return c.json({ ok: true });
  });

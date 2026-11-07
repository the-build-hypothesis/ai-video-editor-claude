/** Small pure rules: export job transitions, rate-limit windows, admin ranges, admin check, HTTP ranges. */
import type { JobStatus } from '../../shared/api-types';

// ---------- Export job status machine ----------
const TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  queued: ['running', 'failed', 'canceled'],
  running: ['running', 'completed', 'failed', 'canceled'],
  completed: [],
  failed: [],
  canceled: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminal(s: JobStatus): boolean {
  return s === 'completed' || s === 'failed' || s === 'canceled';
}

// ---------- Fixed-window rate limiting ----------
export function windowStart(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

export function retryAfterSeconds(nowMs: number, windowMs: number): number {
  return Math.max(1, Math.ceil((windowStart(nowMs, windowMs) + windowMs - nowMs) / 1000));
}

/** `count` is the counter value AFTER incrementing for this request. */
export function isOverLimit(count: number, limit: number): boolean {
  return count > limit;
}

// ---------- Admin ----------
export const ADMIN_RANGES = { '1h': 3_600_000, '24h': 86_400_000, '3d': 3 * 86_400_000, '7d': 7 * 86_400_000 } as const;
export type AdminRange = keyof typeof ADMIN_RANGES;

/** Returns null for an unknown range. Missing range defaults to 24h. */
export function parseAdminRange(raw: string | null | undefined, nowMs: number): { range: AdminRange; sinceMs: number } | null {
  const r = (raw ?? '24h') as AdminRange;
  if (!Object.prototype.hasOwnProperty.call(ADMIN_RANGES, r)) return null;
  return { range: r, sinceMs: nowMs - ADMIN_RANGES[r] };
}

export function isAdminEmail(email: string | null, isGuest: boolean, adminEmails: string | undefined): boolean {
  if (!email || isGuest || !adminEmails) return false;
  const list = adminEmails.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(email.trim().toLowerCase());
}

// ---------- HTTP Range ----------
export type RangeResult = { start: number; end: number } | 'unsatisfiable' | null;

/**
 * Parses a single `bytes=` range against a resource of `size` bytes. Returns null when the header is
 * absent/unsupported (serve the full body), 'unsatisfiable' for 416, or inclusive [start, end].
 */
export function parseRange(header: string | null | undefined, size: number): RangeResult {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multi-range or malformed: ignore (RFC 9110 allows serving full content)
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (size === 0) return 'unsatisfiable';
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(a);
  if (start >= size) return 'unsatisfiable';
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (end < start) return null;
  return { start, end };
}

/** Safe ASCII filename for Content-Disposition. */
export function sanitizeFilename(name: string, ext: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[\\/:*?"<>|;,\x00-\x1f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 100);
  return `${base || 'export'}.${ext}`;
}

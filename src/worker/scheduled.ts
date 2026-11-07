/** Daily maintenance (cron "17 3 * * *"): guest retention, expired sessions, stale uploads/jobs. */
import type { Env } from './env';
import { deleteObjects, deletePrefix, keys } from './storage';
import { LIMITS } from '../shared/api-types';

const DAY = 86_400_000;

export async function runMaintenance(env: Env, now = Date.now()) {
  const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ level: 'info', msg, ...extra }));
  const stats = { guestsDeleted: 0, objectsDeleted: 0, sessionsDeleted: 0, pendingAssetsDeleted: 0, staleExportsFailed: 0 };

  // Guests inactive for longer than the retention period (last activity, falling back to creation).
  const cutoff = now - LIMITS.guestRetentionDays * DAY;
  const guests = await env.DB.prepare('SELECT id FROM users WHERE is_guest = 1 AND COALESCE(last_seen_at, created_at) < ? LIMIT 200').bind(cutoff).all<{ id: string }>();
  for (const g of guests.results) {
    stats.objectsDeleted += await deletePrefix(env, keys.userPrefix(g.id));
    await env.DB.prepare('DELETE FROM users WHERE id = ? AND is_guest = 1').bind(g.id).run(); // cascades
    stats.guestsDeleted++;
  }

  const s = await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
  stats.sessionsDeleted = s.meta.changes;

  // Uploads that never completed within a day free their reserved quota.
  const pending = await env.DB.prepare("SELECT id, owner_id FROM assets WHERE status IN ('pending','failed') AND updated_at < ? LIMIT 500")
    .bind(now - DAY)
    .all<{ id: string; owner_id: string }>();
  if (pending.results.length) {
    await deleteObjects(env, pending.results.flatMap((a) => [keys.assetOriginal(a.owner_id, a.id), keys.assetThumb(a.owner_id, a.id)]));
    for (const a of pending.results) await env.DB.prepare('DELETE FROM assets WHERE id = ?').bind(a.id).run();
    stats.pendingAssetsDeleted = pending.results.length;
  }

  // Browser-side renders abandoned mid-way.
  const st = await env.DB.prepare("UPDATE exports SET status = 'failed', error = 'Export was abandoned (no progress for 24h)', updated_at = ? WHERE status IN ('queued','running') AND updated_at < ?")
    .bind(now, now - DAY)
    .run();
  stats.staleExportsFailed = st.meta.changes;

  await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - DAY).run();
  log('maintenance completed', stats);
  return stats;
}

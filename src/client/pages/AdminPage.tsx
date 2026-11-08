import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AdminMetricsDTO, HealthDTO } from '../../shared/api-types';
import { navigate } from '../main';
import { useEditor } from '../store';
import { formatBytes } from '../components/ui';
import { AccountMenu } from '../components/AccountMenu';

const RANGES = [
  ['1h', 'Last hour'],
  ['24h', 'Last day'],
  ['3d', 'Last 3 days'],
  ['7d', 'Last 7 days'],
] as const;

export function AdminPage() {
  const user = useEditor((s) => s.user);
  const [range, setRange] = useState<string>('24h');
  const [m, setM] = useState<AdminMetricsDTO | null>(null);
  const [health, setHealth] = useState<HealthDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setErr(null);
    api.adminMetrics(range).then(setM).catch((e) => setErr(e.message));
    api.health().then(setHealth).catch(() => {});
  }, [range]);
  if (!user?.isAdmin)
    return (
      <div className="center-screen">
        <div className="error-box">Administrator access required.</div>
        <button className="btn" onClick={() => navigate('/')}>
          Back
        </button>
      </div>
    );
  const Card = ({ label, value, sub }: { label: string; value: string | number; sub?: string }) => (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
  return (
    <div className="dash">
      <header className="topbar">
        <button className="btn btn-ghost" onClick={() => navigate('/')}>
          ← Projects
        </button>
        <h1 className="h-inline">Operations</h1>
        <div className="spacer" />
        <AccountMenu />
      </header>
      <main className="dash-main">
        <div className="seg" role="tablist" aria-label="Date range">
          {RANGES.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={range === k} className={range === k ? 'active' : ''} onClick={() => setRange(k)}>
              {l}
            </button>
          ))}
        </div>
        {err && <div className="error-box">{err}</div>}
        {health && (
          <p className="muted small">
            Health: {health.ok ? 'OK' : 'DEGRADED'} · database {health.checks.database ? '✓' : '✗'} · storage {health.checks.storage ? '✓' : '✗'} · OpenAI configured {health.openaiConfigured ? '✓' : '✗'} ({health.models.plan}, {health.models.transcription}) · v{health.version}
          </p>
        )}
        {m && (
          <>
            <h2>Users & projects</h2>
            <div className="stats">
              <Card label="Users" value={m.users.total} sub={`${m.users.registered} registered · ${m.users.guests} guests`} />
              <Card label="New users" value={m.users.newInRange} sub="in range" />
              <Card label="Projects" value={m.projects.total} sub={`${m.projects.updatedInRange} edited in range`} />
            </div>
            <h2>Storage & exports</h2>
            <div className="stats">
              <Card label="Media storage" value={formatBytes(m.storage.assetBytes)} sub={`${m.storage.assetCount} files`} />
              <Card label="Export storage" value={formatBytes(m.storage.exportBytes)} />
              <Card
                label="Object store"
                value={m.storage.backend === 'r2' ? 'R2' : 'D1 fallback'}
                sub={m.storage.capBytes ? `${formatBytes(m.storage.usedBytes)} of ${formatBytes(m.storage.capBytes)} cap used — enable R2 to lift it` : 'no fixed cap'}
              />
              <Card label="Exports" value={m.exports.inRange} sub={`${m.exports.completed} completed · ${m.exports.failed} failed (range) · ${m.exports.total} all-time`} />
            </div>
            <h2>AI usage</h2>
            <div className="stats">
              <Card label="AI calls" value={m.ai.calls} sub={`${m.ai.failed} failed`} />
              <Card label="Estimated cost" value={`$${m.ai.costUsd.toFixed(4)}`} sub="based on provider list prices" />
              <Card label="Audio transcribed" value={`${(m.ai.transcribeSeconds / 60).toFixed(1)} min`} />
              <Card label="Tokens" value={`${m.ai.inputTokens} in / ${m.ai.outputTokens} out`} />
            </div>
            <p className="muted small">Aggregates only. Administrators cannot view users' media or project contents from this page.</p>
          </>
        )}
      </main>
    </div>
  );
}

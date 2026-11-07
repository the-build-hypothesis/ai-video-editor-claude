import { useEffect, useState } from 'react';
import { useEditor, getAssetIndex } from '../store';
import { api, ApiError } from '../api';
import { applyAiPlan, type AiPlan, type AppliedOp } from '../../shared/ai-actions';
import { Icon } from './ui';
import { transcribeClip } from '../transcribe';
import type { AiOperationDTO } from '../../shared/api-types';

const EXAMPLES = [
  'Add a title "My Trip" at the start for 3 seconds and fade the music out over the last 2 seconds',
  'Lower the background music to 30% and add a 1 second dissolve between the first two clips',
  'Create captions for the clip with speech',
  'Make the second clip a bit brighter and more saturated',
];

export function AiPanel() {
  const project = useEditor((s) => s.project)!;
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ plan: AiPlan; results: AppliedOp[]; enabled: boolean[]; latencyMs: number; baseProject: unknown } | null>(null);
  const [confirmDestructive, setConfirmDestructive] = useState(false);
  const [history, setHistory] = useState<AiOperationDTO[]>([]);
  const [applied, setApplied] = useState<string | null>(null);

  const loadHistory = () =>
    api
      .aiOperations(project.id)
      .then((r) => setHistory(r.operations))
      .catch(() => {});
  useEffect(() => {
    void loadHistory();
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = instruction.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    setPlan(null);
    setApplied(null);
    setConfirmDestructive(false);
    try {
      // Server builds the AI context from the saved project, so flush pending edits first.
      await useEditor.getState().saveNow();
      const t0 = performance.now();
      const r = await api.plan(project.id, text);
      const cur = useEditor.getState().project!;
      const dry = applyAiPlan(cur, r.plan.operations, { assets: getAssetIndex() });
      setPlan({ plan: r.plan, results: dry.results, enabled: dry.results.map((x) => x.ok), latencyMs: Math.round(performance.now() - t0), baseProject: cur });
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'ai_not_configured' ? 'AI is not configured on this server (missing OpenAI key). Manual editing still works.' : (err as Error).message);
    } finally {
      setBusy(false);
      void loadHistory();
    }
  };

  const toggle = (i: number) => {
    if (!plan) return;
    const enabled = [...plan.enabled];
    enabled[i] = !enabled[i];
    // Re-validate with only the enabled operations (later ops may depend on earlier ones).
    const cur = useEditor.getState().project!;
    const dry = applyAiPlan(cur, plan.plan.operations, { assets: getAssetIndex() }, enabled);
    setPlan({ ...plan, enabled, results: dry.results.map((r, j) => (enabled[j] ? r : { ...plan.results[j], ok: plan.results[j].ok })) });
  };

  const selected = plan ? plan.results.filter((r, i) => plan.enabled[i] && r.ok) : [];
  const destructive = selected.some((r) => r.destructive);

  const apply = async () => {
    if (!plan) return;
    const st = useEditor.getState();
    if (st.project !== plan.baseProject) {
      // Project changed since the dry run — re-validate against the current state.
      const dry = applyAiPlan(st.project!, plan.plan.operations, { assets: getAssetIndex() }, plan.enabled);
      setPlan({ ...plan, results: dry.results, baseProject: st.project });
      if (dry.results.some((r, i) => plan.enabled[i] && !r.ok)) {
        setError('The project changed since this plan was proposed; some operations are no longer valid. Review and apply again.');
        return;
      }
    }
    let followUps: AppliedOp['followUp'][] = [];
    const ok = st.edit(`AI: ${plan.plan.summary.slice(0, 60)}`, (p, ctx) => {
      const r = applyAiPlan(p, plan.plan.operations, ctx, plan.enabled);
      followUps = r.results.filter((x) => x.ok && x.followUp).map((x) => x.followUp);
      return r.project;
    });
    const count = selected.length;
    setPlan(null);
    if (ok || followUps.length) setApplied(`Applied ${count} change${count === 1 ? '' : 's'}. Use Undo (Ctrl+Z) to revert.`);
    for (const f of followUps) {
      if (f?.kind === 'transcribe') {
        try {
          st.toast('info', 'Transcribing for captions…');
          const n = await transcribeClip(f.clipId, { replace: true });
          st.toast('success', `Created ${n} captions. Review them in the Captions tab.`);
          st.set({ rightTab: 'captions' });
        } catch (e) {
          st.toast('error', `Transcription failed: ${(e as Error).message}`);
        }
      }
    }
    void loadHistory();
  };

  return (
    <div className="ai-panel">
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span className="field-label">Describe an edit</span>
          <textarea
            className="input"
            rows={3}
            maxLength={2000}
            value={instruction}
            placeholder="e.g. Add a title at the start and fade the music out at the end"
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit();
            }}
            data-testid="ai-instruction"
          />
        </label>
        <button className="btn btn-primary btn-block" disabled={busy || !instruction.trim()} data-testid="ai-submit">
          {busy ? (
            <>
              <span className="spinner sm" /> Planning edit…
            </>
          ) : (
            <>
              <Icon name="sparkle" /> Propose changes
            </>
          )}
        </button>
      </form>
      {!plan && !busy && (
        <div className="examples">
          <p className="muted small">Try:</p>
          {EXAMPLES.map((ex) => (
            <button key={ex} className="chip" onClick={() => setInstruction(ex)}>
              {ex}
            </button>
          ))}
          <p className="hint">The assistant proposes typed edit operations (add text, move, trim, split, delete, volume, fades, transitions, speed, color, aspect ratio, captions, ducking). Nothing changes until you apply, and everything can be undone.</p>
        </div>
      )}
      {error && (
        <div className="error-box" role="alert">
          {error}{' '}
          <button className="btn btn-sm" onClick={() => void submit()}>
            Retry
          </button>
        </div>
      )}
      {applied && (
        <div className="success-box" role="status">
          {applied}{' '}
          <button className="btn btn-sm" onClick={() => useEditor.getState().undo()}>
            Undo
          </button>
        </div>
      )}
      {plan && (
        <div className="plan" data-testid="ai-plan">
          <h4>Proposed changes</h4>
          <p>{plan.plan.summary}</p>
          {plan.results.length === 0 && <p className="muted">No supported operations were proposed.</p>}
          <ul className="op-list">
            {plan.results.map((r, i) => (
              <li key={i} className={`op ${r.ok ? '' : 'op-invalid'} ${r.destructive ? 'op-destructive' : ''}`}>
                <label className="check">
                  <input type="checkbox" disabled={!r.ok && !plan.enabled[i]} checked={plan.enabled[i] && r.ok} onChange={() => toggle(i)} aria-label={`Include: ${r.description}`} />
                  <span>
                    <span className="op-type">{r.op.type}</span> {r.description}
                    {r.destructive && <span className="pill pill-warn">destructive</span>}
                    {!r.ok && <span className="op-error">Rejected: {r.error}</span>}
                    {r.op.reason && <span className="muted small op-reason">{r.op.reason}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {plan.plan.unsupported.length > 0 && (
            <div className="note">
              <strong>Not supported / not done:</strong>
              <ul>
                {plan.plan.unsupported.map((u, i) => (
                  <li key={i}>{u}</li>
                ))}
              </ul>
            </div>
          )}
          {destructive && (
            <label className="check warn">
              <input type="checkbox" checked={confirmDestructive} onChange={(e) => setConfirmDestructive(e.target.checked)} data-testid="ai-confirm-destructive" /> I understand some changes remove or shorten content (still undoable).
            </label>
          )}
          <div className="row">
            <button className="btn btn-primary" disabled={selected.length === 0 || (destructive && !confirmDestructive)} onClick={apply} data-testid="ai-apply">
              Apply {selected.length} change{selected.length === 1 ? '' : 's'}
            </button>
            <button className="btn" onClick={() => setPlan(null)}>
              Discard
            </button>
          </div>
          <p className="muted small">Response time {plan.latencyMs} ms</p>
        </div>
      )}
      {history.length > 0 && (
        <details className="ai-history">
          <summary>AI usage for this project ({history.length})</summary>
          <table className="mini-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Kind</th>
                <th>Status</th>
                <th>Latency</th>
                <th>Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} title={h.error ?? h.model}>
                  <td>{new Date(h.createdAt).toLocaleTimeString()}</td>
                  <td>{h.kind}</td>
                  <td className={h.status === 'failed' ? 'danger' : ''}>{h.status}</td>
                  <td>{h.latencyMs !== null ? `${(h.latencyMs / 1000).toFixed(1)}s` : '—'}</td>
                  <td>{h.costUsd !== null ? `$${h.costUsd.toFixed(5)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

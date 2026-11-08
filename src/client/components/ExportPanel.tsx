import { useEffect, useRef, useState } from 'react';
import { useEditor, getAssetIndex } from '../store';
import { api, exportDownloadUrl, uploadWithProgress, ApiError } from '../api';
import { exportMp4, checkExportSupport, outputSize, ExportCanceled, type ExportProgress } from '../engine/exporter';
import { Icon, formatBytes, confirmDialog } from './ui';
import { projectDurationUs } from '../../shared/model';
import { formatShort } from '../../shared/time';
import type { ExportDTO } from '../../shared/api-types';
import { LIMITS } from '../../shared/api-types';
import { pause } from '../actions';
import { reframeForAspect } from '../../shared/commands';
import { migrateProject } from '../../shared/migrate';
import { navigate } from '../main';
import { ASPECT_PRESETS, type AspectPreset } from '../../shared/model';

const PRESETS = {
  '1080p': { shortSide: 1080, videoBitrate: 8_000_000 },
  '720p': { shortSide: 720, videoBitrate: 4_000_000 },
} as const;

export function ExportPanel() {
  const project = useEditor((s) => s.project)!;
  const [preset, setPreset] = useState<keyof typeof PRESETS>('1080p');
  const [fps, setFps] = useState(project.settings.fps);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [support, setSupport] = useState<{ ok: boolean; reason?: string } | null>(null);
  const [history, setHistory] = useState<ExportDTO[]>([]);
  const [localResult, setLocalResult] = useState<{ url: string; name: string; size: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const jobRef = useRef<string | null>(null);
  const dur = projectDurationUs(project);
  const size = outputSize(project, PRESETS[preset].shortSide);

  useEffect(() => {
    void checkExportSupport(size.width, size.height).then(setSupport);
  }, [size.width, size.height]);
  const loadHistory = () =>
    api
      .listExports(project.id)
      .then((r) => setHistory(r.exports))
      .catch(() => {});
  useEffect(() => {
    void loadHistory();
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const missing = project.tracks.flatMap((t) => t.clips).filter((c) => c.kind !== 'text' && !getAssetIndex()[c.assetId]);
  const running = progress !== null || uploadPct !== null;

  const start = async () => {
    pause();
    setError(null);
    setLocalResult(null);
    await useEditor.getState().saveNow();
    const abort = new AbortController();
    abortRef.current = abort;
    const name = `${project.name.replace(/[^\w\- ]+/g, '').trim() || 'export'}-${preset}.mp4`;
    let job: ExportDTO | null = null;
    try {
      const out = outputSize(project, PRESETS[preset].shortSide);
      job = (await api.createExport({ projectId: project.id, preset, width: out.width, height: out.height, fps, durationUs: dur })).export;
      jobRef.current = job.id;
      await api.patchExport(job.id, { status: 'running', progress: 0 });
      let lastReport = 0;
      setProgress({ phase: 'preparing', progress: 0 });
      // Export renders a snapshot of the project; further edits don't affect a running export.
      const snapshot = structuredClone(project);
      const result = await exportMp4(
        snapshot,
        getAssetIndex(),
        { shortSide: PRESETS[preset].shortSide, fps, videoBitrate: PRESETS[preset].videoBitrate, audioBitrate: 192_000 },
        (p) => {
          setProgress(p);
          const now = Date.now();
          if (now - lastReport > 3000 && job) {
            lastReport = now;
            void api.patchExport(job.id, { status: 'running', progress: Math.min(0.95, p.progress * 0.9) }).catch(() => {});
          }
        },
        abort.signal,
      );
      setProgress(null);
      const url = URL.createObjectURL(result.blob);
      setLocalResult({ url, name, size: result.blob.size });
      if (result.blob.size > LIMITS.maxExportBytes) {
        await api.patchExport(job.id, { status: 'failed', error: `File too large to store (${formatBytes(result.blob.size)}); downloaded locally only` });
        setError(`The file is larger than the ${formatBytes(LIMITS.maxExportBytes)} storage limit, so it was not saved to your export history. Download it below.`);
      } else {
        setUploadPct(0);
        await uploadWithProgress(`/api/exports/${job.id}/file`, result.blob, 'video/mp4', setUploadPct, abort.signal);
        setUploadPct(null);
        useEditor.getState().toast('success', `Export complete: ${result.width}×${result.height}, ${formatShort(result.durationUs)}, ${formatBytes(result.blob.size)}`);
      }
    } catch (e) {
      setProgress(null);
      setUploadPct(null);
      const canceled = e instanceof ExportCanceled || (e instanceof ApiError && e.code === 'canceled');
      const msg = canceled ? 'Export canceled.' : (e as Error).message || String(e);
      if (job) await api.patchExport(job.id, { status: canceled ? 'canceled' : 'failed', error: canceled ? undefined : msg.slice(0, 500) }).catch(() => {});
      if (!canceled) setError(`Export failed: ${msg}. Your project was not changed — you can retry.`);
      else useEditor.getState().toast('info', 'Export canceled');
    } finally {
      abortRef.current = null;
      jobRef.current = null;
      void loadHistory();
    }
  };

  const del = async (x: ExportDTO) => {
    if (!(await confirmDialog({ title: 'Delete this export?', message: 'The stored MP4 file will be removed.', confirmLabel: 'Delete', danger: true }))) return;
    await api.deleteExport(x.id).catch((e) => useEditor.getState().toast('error', e.message));
    void loadHistory();
  };

  return (
    <div className="export-panel">
      <section className="insp-section">
        <h4>Export MP4</h4>
        <div className="grid2">
          <label className="field">
            <span className="field-label">Resolution</span>
            <select className="input" value={preset} onChange={(e) => setPreset(e.target.value as keyof typeof PRESETS)} disabled={running} data-testid="export-preset">
              <option value="1080p">1080p</option>
              <option value="720p">720p (faster)</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Frame rate</span>
            <select className="input" value={fps} onChange={(e) => setFps(Number(e.target.value) as 30)} disabled={running}>
              {[24, 25, 30, 50, 60].map((f) => (
                <option key={f} value={f}>
                  {f} fps
                </option>
              ))}
            </select>
          </label>
        </div>
        <dl className="kv">
          <dt>Output</dt>
          <dd>
            {size.width}×{size.height}, {fps} fps
          </dd>
          <dt>Duration</dt>
          <dd>{formatShort(dur)}</dd>
          <dt>Format</dt>
          <dd>MP4 · H.264 video · AAC 48 kHz stereo audio</dd>
          <dt>Captions</dt>
          <dd>{project.captions.segments.length ? (project.captions.burnIn ? `${project.captions.segments.length} burned in` : 'not burned in (disabled)') : 'none'}</dd>
        </dl>
        {support && !support.ok && (
          <div className="error-box" role="alert">
            {support.reason} No fallback format is substituted.
          </div>
        )}
        {missing.length > 0 && <div className="error-box">{missing.length} clip(s) reference deleted media and will render as empty.</div>}
        {dur === 0 && <p className="muted">Add clips to the timeline to export.</p>}
        {!running ? (
          <button className="btn btn-primary btn-block" onClick={start} disabled={!support?.ok || dur === 0} data-testid="start-export">
            <Icon name="export" /> Export {preset}
          </button>
        ) : (
          <div className="export-progress" role="status" aria-live="polite">
            <div className="progress" role="progressbar" aria-valuenow={Math.round((uploadPct ?? progress?.progress ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Export progress">
              <div style={{ width: `${Math.round((uploadPct !== null ? uploadPct : progress?.progress ?? 0) * 100)}%` }} />
            </div>
            <div className="row between">
              <span className="small" data-testid="export-status">
                {uploadPct !== null
                  ? `Saving to your exports… ${Math.round(uploadPct * 100)}%`
                  : progress?.phase === 'video'
                    ? `Rendering frame ${progress.frame ?? 0} / ${progress.frames ?? 0} (${Math.round(progress.progress * 100)}%)`
                    : progress?.phase === 'audio'
                      ? 'Mixing audio…'
                      : progress?.phase === 'finalizing'
                        ? 'Finalizing MP4…'
                        : 'Preparing media…'}
              </span>
              <button className="btn btn-sm" onClick={() => abortRef.current?.abort()}>
                Cancel
              </button>
            </div>
            <p className="hint">Rendering happens in this browser tab — keep it open and visible for best speed.</p>
          </div>
        )}
        {error && (
          <div className="error-box" role="alert">
            {error}
            <button className="btn btn-sm" onClick={start} disabled={running}>
              <Icon name="retry" size={13} /> Retry
            </button>
          </div>
        )}
        {localResult && (
          <div className="success-box">
            <a className="btn btn-primary" href={localResult.url} download={localResult.name} data-testid="download-local">
              Download {localResult.name} ({formatBytes(localResult.size)})
            </a>
            <video className="export-video" src={localResult.url} controls preload="metadata" aria-label="Exported video preview" />
          </div>
        )}
      </section>
      <section className="insp-section">
        <h4>Export history</h4>
        {history.length === 0 && <p className="muted small">No exports yet.</p>}
        <ul className="export-list">
          {history.map((x) => (
            <li key={x.id} className={`export-item status-${x.status}`} data-testid="export-item" data-status={x.status}>
              <div>
                <strong>{x.preset}</strong> · {x.width}×{x.height} · {x.fps} fps · {formatShort(x.durationUs)}
                <div className="muted small">
                  {new Date(x.createdAt).toLocaleString()} · <span className={`status status-${x.status}`}>{x.status}</span>
                  {x.sizeBytes ? ` · ${formatBytes(x.sizeBytes)}` : ''}
                </div>
                {x.error && <div className="small danger">{x.error}</div>}
              </div>
              <div className="row">
                {x.status === 'completed' && (
                  <a className="btn btn-sm" href={exportDownloadUrl(x.id)} download data-testid="download-export">
                    Download
                  </a>
                )}
                <button className="icon-btn danger" aria-label="Delete export" onClick={() => del(x)}>
                  <Icon name="trash" size={13} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <VariantsSection />
      <p className="hint">
        Export runs locally with WebCodecs (H.264) and is stored privately in your account. Supported: recent desktop Chrome/Edge; Safari 17+ and Firefox 130+ may work but are unverified.
      </p>
    </div>
  );
}

/** AI-10: create a reframed copy of the project for social formats (editable afterwards). */
function VariantsSection() {
  const project = useEditor((s) => s.project)!;
  const [busy, setBusy] = useState<string | null>(null);
  const current = (Object.keys(ASPECT_PRESETS) as AspectPreset[]).find((k) => ASPECT_PRESETS[k].width === project.settings.width && ASPECT_PRESETS[k].height === project.settings.height);
  const create = async (aspect: AspectPreset) => {
    setBusy(aspect);
    try {
      await useEditor.getState().saveNow();
      const dup = (await api.duplicateProject(project.id)).project;
      const full = (await api.getProject(dup.id)).project;
      const reframed = reframeForAspect(migrateProject(full.data), { aspect, name: `${project.name} (${aspect})` });
      await api.saveProject(dup.id, reframed, full.version);
      useEditor.getState().toast('success', `Created "${reframed.name}". Adjust framing with X/Y in the Inspector or by dragging in the preview.`);
      navigate(`/project/${dup.id}`);
    } catch (e) {
      useEditor.getState().toast('error', `Could not create the variant: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="insp-section">
      <h4>Social variants</h4>
      <p className="hint">Creates a copy reframed for another aspect ratio. Media fills the frame (centered) and titles are rescaled; the original project is unchanged.</p>
      <div className="row wrap">
        {(['9:16', '1:1', '16:9'] as AspectPreset[])
          .filter((a) => a !== current)
          .map((a) => (
            <button key={a} className="btn btn-sm" disabled={!!busy} onClick={() => create(a)} data-testid={`variant-${a}`}>
              {busy === a ? 'Creating…' : `Create ${a} version`}
            </button>
          ))}
      </div>
    </section>
  );
}

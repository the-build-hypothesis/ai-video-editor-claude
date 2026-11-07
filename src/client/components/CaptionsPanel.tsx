import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../store';
import { Icon, NumField, confirmDialog } from './ui';
import * as cmd from '../../shared/commands';
import { transcribeClip, toSrt } from '../transcribe';
import { seek } from '../actions';
import { secToUs, usToSec, formatShort } from '../../shared/time';
import { findClip, type CaptionSegment } from '../../shared/model';

export function CaptionsPanel() {
  const project = useEditor((s) => s.project)!;
  const assets = useEditor((s) => s.assets);
  const selection = useEditor((s) => s.selection);
  const selectedCaption = useEditor((s) => s.selectedCaption);
  const edit = useEditor((s) => s.edit);
  const caps = project.captions;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const speechClips = project.tracks.flatMap((t) =>
    t.clips.filter((c) => {
      if (c.kind === 'audio') return true;
      if (c.kind !== 'video') return false;
      return assets.find((a) => a.id === c.assetId)?.metadata.hasAudio;
    }),
  );
  const selectedSpeech = selection.length === 1 ? speechClips.find((c) => c.id === selection[0]) : undefined;
  const [clipId, setClipId] = useState<string>('');
  useEffect(() => {
    if (selectedSpeech) setClipId(selectedSpeech.id);
    else if (!speechClips.some((c) => c.id === clipId)) setClipId(speechClips[0]?.id ?? '');
  }, [selectedSpeech?.id, speechClips.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    if (!clipId) return;
    let replace = true;
    if (caps.segments.length) {
      replace = await confirmDialog({ title: 'Replace existing captions?', message: 'Choose Replace to discard all current captions, or Cancel to keep captions outside this clip and add the new ones.', confirmLabel: 'Replace all' });
    }
    setBusy('Starting…');
    setError(null);
    try {
      const n = await transcribeClip(clipId, { replace, onStatus: setBusy });
      useEditor.getState().toast('success', `Created ${n} caption segments — review and correct them below.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const downloadSrt = () => {
    const blob = new Blob([toSrt(caps.segments)], { type: 'application/x-subrip' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${project.name.replace(/[^\w\- ]+/g, '').trim() || 'captions'}.srt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  const clipLabel = (id: string) => {
    const f = findClip(project, id);
    if (!f || f.clip.kind === 'text') return id;
    const a = assets.find((x) => x.id === (f.clip as { assetId: string }).assetId);
    return `${a?.name ?? 'clip'} (${f.track.name}, ${formatShort(f.clip.timelineStartUs)})`;
  };

  return (
    <div className="captions-panel">
      <section className="insp-section">
        <h4>
          <Icon name="sparkle" size={14} /> Auto captions (OpenAI)
        </h4>
        {speechClips.length === 0 ? (
          <p className="muted small">Add a video or audio clip that contains speech to the timeline, then transcribe it here.</p>
        ) : (
          <>
            <label className="field">
              <span className="field-label">Clip to transcribe</span>
              <select className="input" value={clipId} onChange={(e) => setClipId(e.target.value)} data-testid="transcribe-clip">
                {speechClips.map((c) => (
                  <option key={c.id} value={c.id}>
                    {clipLabel(c.id)}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn btn-primary btn-block" onClick={run} disabled={!!busy || !clipId} data-testid="transcribe">
              {busy ? (
                <>
                  <span className="spinner sm" /> {busy}
                </>
              ) : (
                'Transcribe & create captions'
              )}
            </button>
            <p className="hint">Only the trimmed part of the clip is sent to OpenAI (as 16 kHz mono audio). Captions are placed at the clip's timeline position.</p>
          </>
        )}
        {error && (
          <div className="error-box" role="alert">
            {error}
            <button className="btn btn-sm" onClick={run}>
              Retry
            </button>
          </div>
        )}
      </section>

      <section className="insp-section">
        <h4>Display</h4>
        <div className="row wrap">
          <label className="check">
            <input type="checkbox" checked={caps.enabled} onChange={(e) => edit('Toggle captions preview', (p) => cmd.updateCaptionSettings(p, { patch: { enabled: e.target.checked } }))} /> Show in preview
          </label>
          <label className="check">
            <input type="checkbox" checked={caps.burnIn} onChange={(e) => edit('Toggle caption burn-in', (p) => cmd.updateCaptionSettings(p, { patch: { burnIn: e.target.checked } }))} data-testid="burn-in" /> Burn into export
          </label>
        </div>
        <div className="grid2">
          <NumField label="Size" suffix="px" value={caps.style.fontSize} step={1} min={12} max={200} decimals={0} onCommit={(v) => edit('Caption size', (p) => cmd.updateCaptionSettings(p, { patch: { style: { fontSize: v } } }))} />
          <label className="field">
            <span className="field-label">Position</span>
            <select className="input" value={caps.style.position} onChange={(e) => edit('Caption position', (p) => cmd.updateCaptionSettings(p, { patch: { style: { position: e.target.value } } }))}>
              <option value="bottom">Bottom</option>
              <option value="middle">Middle</option>
              <option value="top">Top</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Text color</span>
            <input type="color" className="input color" value={caps.style.color.slice(0, 7)} onChange={(e) => edit('Caption color', (p) => cmd.updateCaptionSettings(p, { patch: { style: { color: e.target.value } } }))} />
          </label>
          <label className="field">
            <span className="field-label">Box</span>
            <input type="checkbox" checked={!!caps.style.background} onChange={(e) => edit('Caption box', (p) => cmd.updateCaptionSettings(p, { patch: { style: { background: e.target.checked ? '#000000b3' : null } } }))} aria-label="Caption background box" />
          </label>
        </div>
      </section>

      <section className="insp-section">
        <div className="row between">
          <h4>Segments ({caps.segments.length})</h4>
          <div className="row">
            <button className="btn btn-sm" onClick={() => edit('Add caption', (p) => cmd.addCaption(p, { startUs: useEditor.getState().playhead, endUs: useEditor.getState().playhead + 2_000_000, text: 'New caption' }))}>
              <Icon name="plus" size={13} /> At playhead
            </button>
            {caps.segments.length > 0 && (
              <button className="btn btn-sm" onClick={downloadSrt} title="Download captions as SRT">
                SRT
              </button>
            )}
            {caps.segments.length > 0 && (
              <button
                className="btn btn-sm btn-ghost danger"
                onClick={async () => {
                  if (await confirmDialog({ title: 'Delete all captions?', message: 'You can undo this.', confirmLabel: 'Delete all', danger: true })) edit('Clear captions', (p) => cmd.setCaptions(p, { segments: [] }));
                }}
              >
                Clear
              </button>
            )}
          </div>
        </div>
        {caps.segments.length === 0 && <p className="muted small">No captions yet. Transcribe a clip or add captions manually.</p>}
        <ol className="caption-list">
          {caps.segments.map((s) => (
            <CaptionRow key={s.id} seg={s} selected={selectedCaption === s.id} />
          ))}
        </ol>
      </section>
    </div>
  );
}

function CaptionRow({ seg, selected }: { seg: CaptionSegment; selected: boolean }) {
  const edit = useEditor((s) => s.edit);
  const [text, setText] = useState(seg.text);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => setText(seg.text), [seg.text]);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  return (
    <li ref={ref} className={`caption-row-item ${selected ? 'selected' : ''}`} data-testid="caption-item">
      <div className="row">
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => {
            useEditor.getState().set({ selectedCaption: seg.id, selection: [] });
            seek(seg.startUs);
          }}
          title="Jump to caption"
        >
          ▶ {formatShort(seg.startUs)}
        </button>
        <NumField label="Start" suffix="s" value={usToSec(seg.startUs)} step={0.1} min={0} decimals={2} onCommit={(v) => edit('Caption start', (p) => cmd.updateCaption(p, { id: seg.id, patch: { startUs: secToUs(v) } }))} />
        <NumField label="End" suffix="s" value={usToSec(seg.endUs)} step={0.1} min={0} decimals={2} onCommit={(v) => edit('Caption end', (p) => cmd.updateCaption(p, { id: seg.id, patch: { endUs: secToUs(v) } }))} />
        <button className="icon-btn danger" aria-label="Delete caption" onClick={() => edit('Delete caption', (p) => cmd.removeCaption(p, { id: seg.id }))}>
          <Icon name="trash" size={13} />
        </button>
      </div>
      <textarea
        className="input"
        rows={2}
        value={text}
        maxLength={500}
        aria-label="Caption text"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== seg.text && edit('Edit caption', (p) => cmd.updateCaption(p, { id: seg.id, patch: { text } }))}
        onKeyDown={(e) => e.stopPropagation()}
        data-testid="caption-text"
      />
    </li>
  );
}

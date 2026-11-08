import { useEffect, useState } from 'react';
import { useEditor } from '../store';
import { NumField, RangeField, Icon } from './ui';
import * as cmd from '../../shared/commands';
import { clipEndUs, findClip, TRANSITION_TYPES, TEXT_ANIMATIONS, type Clip, type TextClip, type Project } from '../../shared/model';
import { secToUs, usToSec } from '../../shared/time';
import { deleteSelection, splitAtPlayhead, seek } from '../actions';
import { mediaCache } from '../engine/media-cache';
import { detectSilences, DEFAULT_SILENCE } from '../engine/silence';
import { effectiveTransform } from '../../shared/timeline-eval';

export function Inspector() {
  const project = useEditor((s) => s.project)!;
  const selection = useEditor((s) => s.selection);
  if (selection.length > 1)
    return (
      <div className="inspector">
        <h3>{selection.length} clips selected</h3>
        <p className="muted small">Drag any selected clip to move them together, or delete them.</p>
        <button className="btn btn-danger" onClick={() => deleteSelection()}>
          <Icon name="trash" /> Delete {selection.length} clips
        </button>
      </div>
    );
  const f = selection.length === 1 ? findClip(project, selection[0]) : null;
  if (!f) return <ProjectSettings project={project} />;
  return <ClipInspector key={f.clip.id} clip={f.clip} locked={f.track.locked} trackName={f.track.name} />;
}

function ProjectSettings({ project }: { project: Project }) {
  const edit = useEditor((s) => s.edit);
  return (
    <div className="inspector">
      <h3>Project</h3>
      <p className="muted small">Select a clip on the timeline to edit its timing, position, effects and audio.</p>
      <section className="insp-section">
        <h4>Output</h4>
        <div className="grid2">
          <NumField label="Width" value={project.settings.width} step={2} min={16} max={3840} decimals={0} onCommit={(v) => edit('Set width', (p) => cmd.updateSettings(p, { patch: { width: Math.round(v / 2) * 2 } }))} />
          <NumField label="Height" value={project.settings.height} step={2} min={16} max={3840} decimals={0} onCommit={(v) => edit('Set height', (p) => cmd.updateSettings(p, { patch: { height: Math.round(v / 2) * 2 } }))} />
        </div>
        <label className="field">
          <span className="field-label">Frame rate (timebase for snapping & export)</span>
          <select className="input" value={project.settings.fps} onChange={(e) => edit('Set frame rate', (p) => cmd.updateSettings(p, { patch: { fps: Number(e.target.value) as 30 } }))}>
            {[24, 25, 30, 50, 60].map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Background color</span>
          <input type="color" className="input color" value={project.settings.backgroundColor.slice(0, 7)} onChange={(e) => edit('Background color', (p) => cmd.updateSettings(p, { patch: { backgroundColor: e.target.value } }))} />
        </label>
        <RangeField label="Master volume" value={project.settings.masterVolume} min={0} max={2} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onCommit={(v) => edit('Master volume', (p) => cmd.updateSettings(p, { patch: { masterVolume: v } }))} />
        <p className="hint">Mix policy: all audio is summed, scaled by master volume, then passed through a limiter at −1 dBFS to prevent clipping — identical in preview and export.</p>
      </section>
      <section className="insp-section">
        <h4>Track volumes</h4>
        {project.tracks.map((t) => (
          <RangeField key={t.id} label={`${t.name}${t.kind === 'video' ? ' (clip audio)' : ''}`} value={t.volume} min={0} max={2} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onCommit={(v) => edit(`${t.name} volume`, (p) => cmd.updateTrack(p, { trackId: t.id, patch: { volume: v } }))} />
        ))}
      </section>
    </div>
  );
}

function ClipInspector({ clip, locked, trackName }: { clip: Clip; locked: boolean; trackName: string }) {
  const edit = useEditor((s) => s.edit);
  const assets = useEditor((s) => s.assets);
  const fps = useEditor((s) => s.project!.settings.fps);
  const upd = (label: string, patch: Record<string, unknown>) => edit(label, (p, ctx) => cmd.updateClip(p, { clipId: clip.id, patch }, ctx));
  const asset = clip.kind !== 'text' ? assets.find((a) => a.id === clip.assetId) : null;
  const frameStep = 1 / fps;
  return (
    <div className="inspector" data-testid="inspector">
      <div className="insp-head">
        <h3>
          {clip.kind === 'text' ? 'Text' : clip.kind[0].toUpperCase() + clip.kind.slice(1)} clip <span className="muted small">on {trackName}</span>
        </h3>
        {locked && <span className="pill pill-warn">Track locked</span>}
      </div>
      {asset && (
        <p className="muted small" title={asset.name}>
          Source: {asset.name}
          {asset.metadata.durationUs ? ` (${usToSec(asset.metadata.durationUs).toFixed(2)}s)` : ''}
        </p>
      )}
      {!asset && clip.kind !== 'text' && <div className="error-box small">The media for this clip was deleted. Remove the clip or re-import the file.</div>}
      <fieldset disabled={locked} className="plain">
        {clip.kind === 'text' && <TextSection clip={clip} />}
        <section className="insp-section">
          <h4>Timing</h4>
          <TrackSelect clip={clip} />
          <div className="grid2">
            <NumField label="Start" suffix="s" value={usToSec(clip.timelineStartUs)} step={frameStep} min={0} decimals={3} onCommit={(v) => edit('Set start', (p) => cmd.moveClip(p, { clipId: clip.id, timelineStartUs: secToUs(v) }))} />
            <NumField label="Duration" suffix="s" value={usToSec(clip.durationUs)} step={frameStep} min={0.034} decimals={3} onCommit={(v) => edit('Set duration', (p, ctx) => cmd.trimClip(p, { clipId: clip.id, endUs: clip.timelineStartUs + secToUs(v) }, ctx))} />
            <NumField label="End" suffix="s" value={usToSec(clipEndUs(clip))} step={frameStep} min={0} decimals={3} onCommit={(v) => edit('Set end', (p, ctx) => cmd.trimClip(p, { clipId: clip.id, endUs: secToUs(v) }, ctx))} />
            {clip.kind !== 'text' && clip.kind !== 'image' && (
              <NumField label="Source in" suffix="s" value={usToSec(clip.sourceStartUs)} step={frameStep} min={0} max={asset?.metadata.durationUs ? usToSec(asset.metadata.durationUs) - 0.034 : undefined} decimals={3} onCommit={(v) => upd('Set source in', { sourceStartUs: secToUs(v) })} />
            )}
          </div>
          <p className="hint">Times are on the project timeline (end is exclusive). Source in is the media time shown at the clip start.</p>
          <div className="row">
            <button className="btn btn-sm" onClick={splitAtPlayhead}>
              <Icon name="split" size={14} /> Split at playhead
            </button>
            <button className="btn btn-sm btn-danger" onClick={() => deleteSelection()}>
              <Icon name="trash" size={14} /> Delete
            </button>
          </div>
        </section>
        {clip.kind !== 'audio' && <TransformSection clip={clip} upd={upd} />}
        {(clip.kind === 'video' || clip.kind === 'image') && (
          <section className="insp-section">
            <h4>Color</h4>
            <RangeField label="Brightness" value={clip.adjust.brightness} min={-1} max={1} step={0.01} onCommit={(v) => upd('Brightness', { adjust: { brightness: v } })} />
            <RangeField label="Contrast" value={clip.adjust.contrast} min={-1} max={1} step={0.01} onCommit={(v) => upd('Contrast', { adjust: { contrast: v } })} />
            <RangeField label="Saturation" value={clip.adjust.saturation} min={-1} max={1} step={0.01} onCommit={(v) => upd('Saturation', { adjust: { saturation: v } })} />
            <button className="btn btn-sm" onClick={() => upd('Reset color', { adjust: { brightness: 0, contrast: 0, saturation: 0 } })}>
              Reset
            </button>
          </section>
        )}
        <section className="insp-section">
          <h4>Fades</h4>
          <div className="grid2">
            <NumField label="Fade in" suffix="s" value={usToSec(clip.fadeInUs)} step={0.1} min={0} max={usToSec(clip.durationUs)} onCommit={(v) => upd('Fade in', { fadeInUs: Math.min(secToUs(v), clip.durationUs - clip.fadeOutUs) })} />
            <NumField label="Fade out" suffix="s" value={usToSec(clip.fadeOutUs)} step={0.1} min={0} max={usToSec(clip.durationUs)} onCommit={(v) => upd('Fade out', { fadeOutUs: Math.min(secToUs(v), clip.durationUs - clip.fadeInUs) })} />
          </div>
          <p className="hint">{clip.kind === 'audio' ? 'Fades ramp the clip volume.' : clip.kind === 'video' ? 'Fades apply to both picture opacity and the clip audio.' : 'Fades ramp opacity.'}</p>
        </section>
        {(clip.kind === 'video' || clip.kind === 'image') && <TransitionSection clip={clip} />}
        {(clip.kind === 'video' || clip.kind === 'audio') && (
          <section className="insp-section">
            <h4>Audio & speed</h4>
            {clip.kind === 'video' && asset && !asset.metadata.hasAudio && <p className="muted small">This video has no audio track.</p>}
            <RangeField label="Volume" value={clip.volume} min={0} max={2} step={0.01} format={(v) => `${Math.round(v * 100)}% (${v > 0 ? (20 * Math.log10(v)).toFixed(1) : '-∞'} dB)`} onCommit={(v) => upd('Volume', { volume: v })} />
            <label className="check">
              <input type="checkbox" checked={clip.muted} onChange={(e) => upd(e.target.checked ? 'Mute clip' : 'Unmute clip', { muted: e.target.checked })} /> Mute clip
            </label>
            <label className="field">
              <span className="field-label">Speed</span>
              <select
                className="input"
                value={clip.speed}
                onChange={(e) => {
                  const s = Number(e.target.value);
                  upd(`Speed ${s}×`, { speed: s, durationUs: Math.round((clip.durationUs * clip.speed) / s) });
                }}
              >
                {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((s) => (
                  <option key={s} value={s}>
                    {s}×
                  </option>
                ))}
              </select>
            </label>
            <p className="hint">Speed changes keep the same source range and change the clip length. Audio is resampled, so pitch shifts with speed.</p>
            {clip.gainPoints.length > 0 && (
              <div className="row">
                <span className="muted small">Volume automation: {clip.gainPoints.length} points (e.g. ducking)</span>
                <button className="btn btn-sm" onClick={() => upd('Clear automation', { gainPoints: [] })}>
                  Clear
                </button>
              </div>
            )}
            <DuckButton clip={clip} />
            <SilenceTool clip={clip} />
          </section>
        )}
      </fieldset>
    </div>
  );
}

function DuckButton({ clip }: { clip: Clip }) {
  const edit = useEditor((s) => s.edit);
  const caps = useEditor((s) => s.project!.captions.segments.length);
  const [level, setLevel] = useState(0.25);
  if (clip.kind !== 'audio') return null;
  return (
    <div className="duck">
      <RangeField label="Duck under speech to" value={level} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onCommit={setLevel} />
      <button className="btn btn-sm" disabled={caps === 0} title={caps === 0 ? 'Create captions first — ducking uses caption timing to detect speech' : ''} onClick={() => edit('Duck under speech', (p) => cmd.duckUnderCaptions(p, { clipId: clip.id, duckGain: level }))}>
        Auto-duck under dialogue
      </button>
    </div>
  );
}

function TransformSection({ clip, upd }: { clip: Exclude<Clip, { kind: 'audio' }>; upd: (l: string, p: Record<string, unknown>) => boolean }) {
  const edit = useEditor((s) => s.edit);
  const playhead = useEditor((s) => s.playhead);
  const localUs = Math.max(0, Math.min(clip.durationUs, playhead - clip.timelineStartUs));
  const animated = clip.keyframes.length > 0;
  // Animated clips show/edit the values at the playhead (auto-key); otherwise the base transform.
  const tr = animated ? effectiveTransform(clip, localUs) : clip.transform;
  const setT = (label: string, patch: Record<string, number>) => edit(label, (p) => cmd.setTransformAt(p, { clipId: clip.id, localUs, patch }));
  const inClip = playhead >= clip.timelineStartUs && playhead <= clipEndUs(clip);
  return (
    <section className="insp-section">
      <h4>Position & size {animated && <span className="pill">animated · editing at playhead</span>}</h4>
      <div className="grid2">
        <NumField label="X" suffix="px" value={tr.x} step={1} decimals={0} onCommit={(v) => setT('Position X', { x: v })} />
        <NumField label="Y" suffix="px" value={tr.y} step={1} decimals={0} onCommit={(v) => setT('Position Y', { y: v })} />
        <NumField label="Scale" suffix="%" value={tr.scale * 100} step={1} min={1} max={2000} decimals={0} onCommit={(v) => setT('Scale', { scale: v / 100 })} />
        <NumField label="Rotation" suffix="°" value={tr.rotation} step={1} min={-360} max={360} decimals={0} onCommit={(v) => setT('Rotation', { rotation: v })} />
      </div>
      <RangeField label="Opacity" value={tr.opacity} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onCommit={(v) => setT('Opacity', { opacity: v })} />
      <div className="keyframes" data-testid="keyframes">
        <div className="row between">
          <h5>Keyframes ({clip.keyframes.length})</h5>
          <button
            className="btn btn-sm"
            disabled={!inClip}
            title={inClip ? 'Record the current position/size/rotation/opacity at the playhead' : 'Move the playhead over this clip first'}
            onClick={() => edit('Add keyframe', (p) => cmd.setTransformAt(p, { clipId: clip.id, localUs, patch: {}, forceKeyframe: true }))}
            data-testid="add-keyframe"
          >
            ◆ Add at playhead
          </button>
        </div>
        {clip.keyframes.length === 0 && <p className="hint">Add two or more keyframes at different times to animate position, scale, rotation and opacity (linear). With keyframes, edits apply at the playhead.</p>}
        <ul className="kf-list">
          {clip.keyframes.map((k) => (
            <li key={k.tUs} className={Math.abs(k.tUs - localUs) <= 20_000 ? 'current' : ''}>
              <button className="btn btn-sm btn-ghost" onClick={() => seek(clip.timelineStartUs + k.tUs)} title="Jump to keyframe">
                ◆ {usToSec(clip.timelineStartUs + k.tUs).toFixed(2)}s
              </button>
              <span className="muted small">
                x {Math.round(k.x)} · y {Math.round(k.y)} · {Math.round(k.scale * 100)}% · {Math.round(k.opacity * 100)}%
              </span>
              <button className="icon-btn xs" aria-label={`Delete keyframe at ${usToSec(k.tUs).toFixed(2)}s`} onClick={() => edit('Delete keyframe', (p) => cmd.removeKeyframe(p, { clipId: clip.id, tUs: k.tUs }))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      </div>
      {clip.kind !== 'text' && (
        <>
          <label className="field">
            <span className="field-label">Fit</span>
            <select className="input" value={tr.fit} onChange={(e) => upd('Fit', { transform: { fit: e.target.value } })}>
              <option value="contain">Fit (letterbox)</option>
              <option value="cover">Fill (crop to frame)</option>
              <option value="stretch">Stretch</option>
              <option value="none">Original size</option>
            </select>
          </label>
          <h5>Crop</h5>
          <div className="grid2">
            {(['left', 'right', 'top', 'bottom'] as const).map((k) => (
              <NumField key={k} label={k[0].toUpperCase() + k.slice(1)} suffix="%" value={tr.crop[k] * 100} step={1} min={0} max={95} decimals={0} onCommit={(v) => upd(`Crop ${k}`, { transform: { crop: { [k]: v / 100 } } })} />
            ))}
          </div>
        </>
      )}
      <div className="row">
        <button className="btn btn-sm" onClick={() => setT('Center', { x: 0, y: 0 })}>
          Center
        </button>
        <button className="btn btn-sm" onClick={() => upd('Reset transform', { transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, crop: { left: 0, right: 0, top: 0, bottom: 0 } } })}>
          Reset
        </button>
      </div>
      <p className="hint">Tip: drag the selected clip directly in the preview to reposition it.</p>
    </section>
  );
}

function TransitionSection({ clip }: { clip: Extract<Clip, { kind: 'video' | 'image' }> }) {
  const edit = useEditor((s) => s.edit);
  const tr = clip.transitionIn;
  const project = useEditor((s) => s.project)!;
  const f = findClip(project, clip.id)!;
  const hasPrev = f.track.clips.some((c) => c.id !== clip.id && Math.abs(clipEndUs(c) - clip.timelineStartUs) <= 20_000);
  const set = (type: string, durS: number) =>
    edit(type === 'none' ? 'Remove transition' : `${type} transition`, (p) => cmd.setTransition(p, { clipId: clip.id, transition: type === 'none' ? null : { type: type as (typeof TRANSITION_TYPES)[number], durationUs: secToUs(durS) } }));
  return (
    <section className="insp-section">
      <h4>Transition in</h4>
      {!hasPrev && <p className="hint">Transitions blend from the clip that ends exactly where this clip starts on the same track. Snap the clips together first.</p>}
      <div className="grid2">
        <label className="field">
          <span className="field-label">Type</span>
          <select className="input" value={tr?.type ?? 'none'} onChange={(e) => set(e.target.value, tr ? usToSec(tr.durationUs) : 1)} data-testid="transition-type">
            <option value="none">None</option>
            <option value="dissolve">Dissolve</option>
            <option value="fadeblack">Dip to black</option>
            <option value="wipeleft">Wipe → right</option>
            <option value="wiperight">Wipe ← left</option>
          </select>
        </label>
        {tr && <NumField label="Duration" suffix="s" value={usToSec(tr.durationUs)} step={0.1} min={0.034} max={5} onCommit={(v) => set(tr.type, v)} />}
      </div>
      {tr && <p className="hint">Centered on the cut: half before, half after. If source media runs out, the edge frame is held.</p>}
    </section>
  );
}

function TextSection({ clip }: { clip: TextClip }) {
  const edit = useEditor((s) => s.edit);
  const [text, setText] = useState(clip.text);
  useEffect(() => setText(clip.text), [clip.text]);
  const upd = (label: string, patch: Record<string, unknown>) => edit(label, (p, ctx) => cmd.updateClip(p, { clipId: clip.id, patch }, ctx));
  const st = clip.style;
  return (
    <section className="insp-section">
      <h4>Text</h4>
      <label className="field">
        <span className="field-label">Content</span>
        <textarea
          className="input"
          rows={3}
          value={text}
          maxLength={2000}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => text !== clip.text && upd('Edit text', { text })}
          onKeyDown={(e) => e.stopPropagation()}
          data-testid="text-content"
        />
      </label>
      <div className="grid2">
        <label className="field">
          <span className="field-label">Font</span>
          <select className="input" value={st.fontFamily} onChange={(e) => upd('Font', { style: { fontFamily: e.target.value } })}>
            {['Inter', 'Arial', 'Georgia', 'Courier New', 'Impact'].map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </label>
        <NumField label="Size" suffix="px" value={st.fontSize} step={1} min={8} max={400} decimals={0} onCommit={(v) => upd('Font size', { style: { fontSize: v } })} />
        <label className="field">
          <span className="field-label">Color</span>
          <input type="color" className="input color" value={st.color.slice(0, 7)} onChange={(e) => upd('Text color', { style: { color: e.target.value } })} aria-label="Text color" />
        </label>
        <label className="field">
          <span className="field-label">Background</span>
          <span className="row">
            <input type="checkbox" checked={!!st.background} onChange={(e) => upd('Text background', { style: { background: e.target.checked ? '#000000aa' : null } })} aria-label="Show background box" />
            {st.background && <input type="color" className="input color" value={st.background.slice(0, 7)} onChange={(e) => upd('Background color', { style: { background: e.target.value + 'cc' } })} aria-label="Background color" />}
          </span>
        </label>
      </div>
      <div className="row wrap">
        <label className="check">
          <input type="checkbox" checked={st.bold} onChange={(e) => upd('Bold', { style: { bold: e.target.checked } })} /> Bold
        </label>
        <label className="check">
          <input type="checkbox" checked={st.italic} onChange={(e) => upd('Italic', { style: { italic: e.target.checked } })} /> Italic
        </label>
        <label className="check">
          <input type="checkbox" checked={st.shadow} onChange={(e) => upd('Shadow', { style: { shadow: e.target.checked } })} /> Shadow
        </label>
      </div>
      <div className="grid2">
        <label className="field">
          <span className="field-label">Align</span>
          <select className="input" value={st.align} onChange={(e) => upd('Align', { style: { align: e.target.value } })}>
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </label>
        <NumField label="Outline" suffix="px" value={st.strokeWidth} step={1} min={0} max={40} decimals={0} onCommit={(v) => upd('Outline', { style: { strokeWidth: v } })} />
        <label className="field">
          <span className="field-label">Animation</span>
          <select className="input" value={clip.animation} onChange={(e) => upd('Animation', { animation: e.target.value })}>
            {TEXT_ANIMATIONS.map((a) => (
              <option key={a} value={a}>
                {{ none: 'None', fade: 'Fade in/out', slideUp: 'Slide up', pop: 'Pop', typewriter: 'Typewriter' }[a]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Position preset</span>
          <select
            className="input"
            value=""
            onChange={(e) => {
              const H = useEditor.getState().project!.settings.height;
              const y = { top: -H * 0.35, center: 0, bottom: H * 0.32 }[e.target.value as 'top'];
              if (y !== undefined) upd('Position', { transform: { x: 0, y } });
            }}
          >
            <option value="">Choose…</option>
            <option value="top">Top</option>
            <option value="center">Center</option>
            <option value="bottom">Bottom</option>
          </select>
        </label>
      </div>
    </section>
  );
}

function TrackSelect({ clip }: { clip: Clip }) {
  const project = useEditor((s) => s.project)!;
  const edit = useEditor((s) => s.edit);
  const f = findClip(project, clip.id)!;
  const options = project.tracks.filter((t) => t.kind === f.track.kind);
  if (options.length < 2) return null;
  return (
    <label className="field">
      <span className="field-label">Track{f.track.kind === 'video' ? ' (upper tracks draw on top)' : ''}</span>
      <select
        className="input"
        value={f.track.id}
        data-testid="clip-track"
        onChange={(e) => edit('Move to track', (p) => cmd.moveClip(p, { clipId: clip.id, timelineStartUs: clip.timelineStartUs, trackId: e.target.value }))}
      >
        {options.map((t) => (
          <option key={t.id} value={t.id} disabled={t.locked}>
            {t.name}
            {t.locked ? ' (locked)' : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

/** AI-09: propose cuts for silent passages (audio energy based), preview them, then remove as one undoable edit. */
function SilenceTool({ clip }: { clip: Clip }) {
  const edit = useEditor((s) => s.edit);
  const assets = useEditor((s) => s.assets);
  const [busy, setBusy] = useState(false);
  const [thresholdDb, setThresholdDb] = useState(DEFAULT_SILENCE.thresholdDb);
  const [minSec, setMinSec] = useState(DEFAULT_SILENCE.minSilenceSec);
  const [found, setFound] = useState<{ startUs: number; endUs: number; on: boolean }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (clip.kind !== 'audio' && clip.kind !== 'video') return null;
  const asset = assets.find((a) => a.id === clip.assetId);
  if (!asset?.metadata.hasAudio) return null;
  const analyze = async () => {
    setBusy(true);
    setErr(null);
    try {
      const buf = await mediaCache.loadAudio(clip.assetId);
      if (!buf) throw new Error('Could not decode audio for this clip.');
      setFound(detectSilences(buf, clip, { thresholdDb, minSilenceSec: minSec, paddingSec: DEFAULT_SILENCE.paddingSec }).map((r) => ({ ...r, on: true })));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const chosen = found?.filter((r) => r.on) ?? [];
  const total = chosen.reduce((a, r) => a + r.endUs - r.startUs, 0);
  return (
    <div className="duck" data-testid="silence-tool">
      <h5>Remove silences</h5>
      <div className="grid2">
        <label className="field">
          <span className="field-label">Silence below</span>
          <select className="input" value={thresholdDb} onChange={(e) => setThresholdDb(Number(e.target.value))}>
            {[-25, -30, -35, -40, -45].map((d) => (
              <option key={d} value={d}>
                {d} dB
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Longer than</span>
          <select className="input" value={minSec} onChange={(e) => setMinSec(Number(e.target.value))}>
            {[0.3, 0.5, 0.6, 0.8, 1, 1.5].map((d) => (
              <option key={d} value={d}>
                {d} s
              </option>
            ))}
          </select>
        </label>
      </div>
      <button className="btn btn-sm" onClick={analyze} disabled={busy} data-testid="find-silences">
        {busy ? 'Analyzing…' : 'Find silent parts'}
      </button>
      {err && <div className="error-box small">{err}</div>}
      {found && found.length === 0 && <p className="muted small">No silences found with these settings.</p>}
      {found && found.length > 0 && (
        <>
          <ul className="op-list">
            {found.map((r, i) => (
              <li key={i} className="op">
                <label className="check">
                  <input type="checkbox" checked={r.on} onChange={() => setFound(found.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))} aria-label={`Cut ${usToSec(r.startUs).toFixed(2)} to ${usToSec(r.endUs).toFixed(2)} seconds`} />
                  <span>
                    {usToSec(r.startUs).toFixed(2)}–{usToSec(r.endUs).toFixed(2)}s ({usToSec(r.endUs - r.startUs).toFixed(2)}s)
                  </span>
                </label>
                <button className="btn btn-sm btn-ghost" onClick={() => seek(Math.max(0, r.startUs - 500_000))} title="Jump the playhead just before this cut to preview it">
                  Preview
                </button>
              </li>
            ))}
          </ul>
          <button
            className="btn btn-sm btn-primary"
            disabled={chosen.length === 0}
            data-testid="apply-silences"
            onClick={() => {
              if (edit(`Remove ${chosen.length} silences`, (p) => cmd.removeRangesFromClip(p, { clipId: clip.id, ranges: chosen }))) setFound(null);
            }}
          >
            Cut {chosen.length} part{chosen.length === 1 ? '' : 's'} (−{usToSec(total).toFixed(1)}s)
          </button>
          <p className="hint">Later clips on this track and captions shift left to close the gaps. Other tracks are not moved. Undo restores everything.</p>
        </>
      )}
    </div>
  );
}

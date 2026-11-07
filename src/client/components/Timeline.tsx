import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, getAssetIndex } from '../store';
import { Icon, confirmDialog } from './ui';
import { ASSET_DRAG_TYPE } from './MediaPanel';
import * as cmd from '../../shared/commands';
import { clipEndUs, projectDurationUs, type Clip, type Project, type Track } from '../../shared/model';
import { snapToFrame, formatShort } from '../../shared/time';
import { addAssetToTimeline, seek, splitAtPlayhead, deleteSelection, duplicateSelection, pause } from '../actions';
import { assetThumbUrl } from '../api';

const HEADER_W = 168;
const TRACK_H: Record<Track['kind'], number> = { video: 58, audio: 50 };
const CAPTION_H = 30;
const SNAP_PX = 8;

type DragState =
  | { kind: 'move'; ids: string[]; startX: number; startY: number; deltaUs: number; trackDelta: number; noSnap: boolean; moved: boolean }
  | { kind: 'trim'; id: string; edge: 'start' | 'end'; startX: number; deltaUs: number }
  | { kind: 'caption'; id: string; mode: 'move' | 'start' | 'end'; startX: number; deltaUs: number }
  | null;

export function Timeline() {
  const project = useEditor((s) => s.project)!;
  const zoom = useEditor((s) => s.zoom);
  const selection = useEditor((s) => s.selection);
  const snapping = useEditor((s) => s.snapping);
  const selectedCaption = useEditor((s) => s.selectedCaption);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState>(null);
  const dragRef = useRef<DragState>(null);
  dragRef.current = drag;
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [dropHint, setDropHint] = useState<{ trackId: string; us: number } | null>(null);

  const durUs = projectDurationUs(project);
  const viewSec = Math.max(30, durUs / 1e6 + 20);
  const contentW = viewSec * zoom;
  const usToX = (us: number) => (us / 1e6) * zoom;
  const xToUs = (x: number) => Math.max(0, (x / zoom) * 1e6);
  const fps = project.settings.fps;

  const snapPoints = useMemo(() => {
    const pts = new Set<number>([0]);
    for (const t of project.tracks) for (const c of t.clips) {
      pts.add(c.timelineStartUs);
      pts.add(clipEndUs(c));
    }
    return [...pts];
  }, [project]);

  const snap = (us: number, exclude: Set<string>, noSnap: boolean): { us: number; line: number | null } => {
    if (!snapping || noSnap) return { us: snapToFrame(us, fps), line: null };
    const pts = [...snapPoints, useEditor.getState().playhead];
    // Exclude edges of the dragged clips themselves.
    const excluded = new Set<number>();
    for (const t of project.tracks) for (const c of t.clips) if (exclude.has(c.id)) {
      excluded.add(c.timelineStartUs);
      excluded.add(clipEndUs(c));
    }
    let best: number | null = null;
    let bestDist = (SNAP_PX / zoom) * 1e6;
    for (const p of pts) {
      if (excluded.has(p) && p !== useEditor.getState().playhead) continue;
      const d = Math.abs(p - us);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return best !== null ? { us: best, line: best } : { us: snapToFrame(us, fps), line: null };
  };

  // ------------------------------------------------------------ clip pointer handlers
  const onClipPointerDown = (e: React.PointerEvent, clip: Clip, track: Track, edge: 'start' | 'end' | null) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    pause();
    const st = useEditor.getState();
    let sel = st.selection;
    if (e.shiftKey || e.metaKey || e.ctrlKey) sel = sel.includes(clip.id) ? sel.filter((x) => x !== clip.id) : [...sel, clip.id];
    else if (!sel.includes(clip.id)) sel = [clip.id];
    st.set({ selection: sel, selectedCaption: null, rightTab: st.rightTab === 'captions' ? 'inspector' : st.rightTab });
    if (track.locked) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (edge) setDrag({ kind: 'trim', id: clip.id, edge, startX: e.clientX, deltaUs: 0 });
    else setDrag({ kind: 'move', ids: sel.filter((id) => !lockedClip(project, id)), startX: e.clientX, startY: e.clientY, deltaUs: 0, trackDelta: 0, noSnap: e.altKey, moved: false });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dxUs = ((e.clientX - d.startX) / zoom) * 1e6;
    if (d.kind === 'move') {
      const lead = findClipIn(project, d.ids[0]);
      if (!lead) return;
      const exclude = new Set(d.ids);
      // Snap either the start or end edge of the lead clip, whichever is closer.
      const rawStart = Math.max(0, lead.clip.timelineStartUs + dxUs);
      const s1 = snap(rawStart, exclude, d.noSnap || e.altKey);
      const s2 = snap(rawStart + lead.clip.durationUs, exclude, d.noSnap || e.altKey);
      let newStart = s1.us;
      let line = s1.line;
      if (s2.line !== null && (s1.line === null || Math.abs(s2.us - lead.clip.durationUs - rawStart) < Math.abs(s1.us - rawStart))) {
        newStart = s2.us - lead.clip.durationUs;
        line = s2.line;
      }
      // Never move any selected clip before 0.
      const minStart = Math.min(...d.ids.map((id) => findClipIn(project, id)?.clip.timelineStartUs ?? 0));
      let delta = newStart - lead.clip.timelineStartUs;
      if (minStart + delta < 0) delta = -minStart;
      // Vertical track change (only for single-clip moves).
      const trackDelta = d.ids.length === 1 ? Math.round((e.clientY - d.startY) / TRACK_H.video) : 0;
      setSnapLine(line);
      setDrag({ ...d, deltaUs: delta, trackDelta, moved: d.moved || Math.abs(e.clientX - d.startX) > 2 || Math.abs(e.clientY - d.startY) > 4 });
    } else if (d.kind === 'trim') {
      const f = findClipIn(project, d.id);
      if (!f) return;
      const edgeUs = d.edge === 'start' ? f.clip.timelineStartUs : clipEndUs(f.clip);
      const s = snap(edgeUs + dxUs, new Set([d.id]), e.altKey);
      setSnapLine(s.line);
      setDrag({ ...d, deltaUs: s.us - edgeUs });
    } else if (d.kind === 'caption') {
      setDrag({ ...d, deltaUs: snapToFrame(dxUs, fps) });
    }
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    setDrag(null);
    setSnapLine(null);
    if (!d) return;
    const st = useEditor.getState();
    if (d.kind === 'move' && d.moved && (d.deltaUs !== 0 || d.trackDelta !== 0)) {
      st.edit(d.ids.length > 1 ? `Move ${d.ids.length} clips` : 'Move clip', (p) => {
        let acc = p;
        for (const id of d.ids) {
          const f = findClipIn(acc, id);
          if (!f) continue;
          let trackId: string | undefined;
          if (d.trackDelta) {
            const same = acc.tracks.filter((t) => t.kind === f.track.kind);
            const i = same.findIndex((t) => t.id === f.track.id);
            const target = same[Math.max(0, Math.min(same.length - 1, i + d.trackDelta))];
            trackId = target.id;
          }
          acc = cmd.moveClip(acc, { clipId: id, timelineStartUs: f.clip.timelineStartUs + d.deltaUs, trackId });
        }
        return acc;
      });
    } else if (d.kind === 'trim' && d.deltaUs !== 0) {
      const f = findClipIn(project, d.id);
      if (!f) return;
      st.edit(d.edge === 'start' ? 'Trim start' : 'Trim end', (p, ctx) =>
        cmd.trimClip(p, d.edge === 'start' ? { clipId: d.id, startUs: f.clip.timelineStartUs + d.deltaUs } : { clipId: d.id, endUs: clipEndUs(f.clip) + d.deltaUs }, ctx),
      );
    } else if (d.kind === 'caption' && d.deltaUs !== 0) {
      const seg = project.captions.segments.find((s) => s.id === d.id);
      if (!seg) return;
      const patch =
        d.mode === 'move'
          ? { startUs: Math.max(0, seg.startUs + d.deltaUs), endUs: Math.max(0, seg.startUs + d.deltaUs) + (seg.endUs - seg.startUs) }
          : d.mode === 'start'
            ? { startUs: Math.min(seg.endUs - 100_000, Math.max(0, seg.startUs + d.deltaUs)) }
            : { endUs: Math.max(seg.startUs + 100_000, seg.endUs + d.deltaUs) };
      st.edit('Adjust caption timing', (p) => cmd.updateCaption(p, { id: d.id, patch }));
    }
  };

  // ------------------------------------------------------------ ruler / scrubbing
  const scrubbing = useRef(false);
  const scrubTo = (clientX: number) => {
    const rect = scrollRef.current!.getBoundingClientRect();
    const x = clientX - rect.left + scrollRef.current!.scrollLeft - HEADER_W;
    seek(xToUs(x));
  };

  // ------------------------------------------------------------ asset drop
  const laneDragOver = (e: React.DragEvent, track: Track) => {
    if (!e.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const us = snap(xToUs(e.clientX - rect.left), new Set(), e.altKey).us;
    setDropHint({ trackId: track.id, us });
  };
  const laneDrop = (e: React.DragEvent, track: Track) => {
    const id = e.dataTransfer.getData(ASSET_DRAG_TYPE);
    setDropHint(null);
    if (!id) return;
    e.preventDefault();
    const asset = useEditor.getState().assets.find((a) => a.id === id);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (asset) addAssetToTimeline(asset, { trackId: track.id, atUs: snap(xToUs(e.clientX - rect.left), new Set(), e.altKey).us });
  };

  // Wheel zoom with ctrl.
  useEffect(() => {
    const el = scrollRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const st = useEditor.getState();
      st.setZoom(st.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const videoTracks = project.tracks.filter((t) => t.kind === 'video');
  const audioTracks = project.tracks.filter((t) => t.kind === 'audio');

  const renderTrack = (track: Track) => (
    <div className={`track-row track-${track.kind} ${track.locked ? 'locked' : ''} ${track.hidden ? 'hidden-track' : ''}`} key={track.id} style={{ height: TRACK_H[track.kind] }}>
      <TrackHeader track={track} project={project} />
      <div
        className="lane"
        style={{ width: contentW }}
        onDragOver={(e) => laneDragOver(e, track)}
        onDragLeave={() => setDropHint(null)}
        onDrop={(e) => laneDrop(e, track)}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) {
            useEditor.getState().set({ selection: [], selectedCaption: null });
            scrubTo(e.clientX);
          }
        }}
        data-testid={`lane-${track.name}`}
        aria-label={`${track.name} ${track.kind} track`}
      >
        {dropHint?.trackId === track.id && <div className="drop-hint" style={{ left: usToX(dropHint.us) }} />}
        {track.clips.map((c) => {
          let start = c.timelineStartUs;
          let dur = c.durationUs;
          let ghostTrack = 0;
          if (drag?.kind === 'move' && drag.ids.includes(c.id)) {
            start += drag.deltaUs;
            ghostTrack = drag.trackDelta;
          }
          if (drag?.kind === 'trim' && drag.id === c.id) {
            if (drag.edge === 'start') {
              start += drag.deltaUs;
              dur -= drag.deltaUs;
            } else dur += drag.deltaUs;
            dur = Math.max(33_000, dur);
          }
          return (
            <ClipView
              key={c.id}
              clip={c}
              track={track}
              left={usToX(start)}
              width={Math.max(4, usToX(dur))}
              offsetY={ghostTrack * TRACK_H[track.kind]}
              selected={selection.includes(c.id)}
              dragging={!!drag && ((drag.kind === 'move' && drag.ids.includes(c.id)) || (drag.kind === 'trim' && drag.id === c.id))}
              onPointerDown={onClipPointerDown}
              zoom={zoom}
            />
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="timeline" onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      <TimelineToolbar />
      <div className="tl-scroll" ref={scrollRef}>
        <div className="tl-content" style={{ width: contentW + HEADER_W }}>
          <div className="ruler-row">
            <div className="ruler-corner muted small">{formatShort(durUs)}</div>
            <div
              className="ruler"
              style={{ width: contentW }}
              onPointerDown={(e) => {
                scrubbing.current = true;
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                pause();
                scrubTo(e.clientX);
              }}
              onPointerMove={(e) => scrubbing.current && scrubTo(e.clientX)}
              onPointerUp={() => (scrubbing.current = false)}
              data-testid="ruler"
              role="slider"
              aria-label="Timeline position"
              aria-valuemin={0}
              aria-valuemax={Math.round(durUs / 1e6)}
              aria-valuenow={Math.round(useEditor.getState().playhead / 1e6)}
              tabIndex={0}
            >
              <RulerTicks zoom={zoom} seconds={viewSec} />
            </div>
          </div>
          {videoTracks.map(renderTrack)}
          <div className="track-row caption-row" style={{ height: CAPTION_H }}>
            <div className="track-header caption-header">
              <Icon name="cc" size={14} /> <span>Captions</span>
            </div>
            <div className="lane caption-lane" style={{ width: contentW }}>
              {project.captions.segments.map((s) => {
                let start = s.startUs;
                let end = s.endUs;
                if (drag?.kind === 'caption' && drag.id === s.id) {
                  if (drag.mode === 'move') {
                    start += drag.deltaUs;
                    end += drag.deltaUs;
                  } else if (drag.mode === 'start') start += drag.deltaUs;
                  else end += drag.deltaUs;
                }
                return (
                  <div
                    key={s.id}
                    className={`caption-chip ${selectedCaption === s.id ? 'selected' : ''}`}
                    style={{ left: usToX(start), width: Math.max(4, usToX(end - start)) }}
                    title={s.text}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      pause();
                      useEditor.getState().set({ selectedCaption: s.id, selection: [], rightTab: 'captions' });
                      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      const mode = e.clientX - rect.left < 6 ? 'start' : rect.right - e.clientX < 6 ? 'end' : 'move';
                      setDrag({ kind: 'caption', id: s.id, mode, startX: e.clientX, deltaUs: 0 });
                    }}
                  >
                    {s.text}
                  </div>
                );
              })}
            </div>
          </div>
          {audioTracks.map(renderTrack)}
          <Playhead zoom={zoom} />
          {snapLine !== null && <div className="snap-line" style={{ left: HEADER_W + usToX(snapLine) }} />}
        </div>
      </div>
    </div>
  );
}

function lockedClip(p: Project, id: string) {
  return findClipIn(p, id)?.track.locked ?? true;
}
function findClipIn(p: Project, id: string) {
  for (const t of p.tracks) {
    const c = t.clips.find((x) => x.id === id);
    if (c) return { track: t, clip: c };
  }
  return null;
}

function TimelineToolbar() {
  const zoom = useEditor((s) => s.zoom);
  const snapping = useEditor((s) => s.snapping);
  const hasSel = useEditor((s) => s.selection.length > 0 || !!s.selectedCaption);
  const set = useEditor((s) => s.set);
  const project = useEditor((s) => s.project)!;
  const fit = () => {
    const el = document.querySelector('.tl-scroll') as HTMLElement | null;
    const dur = projectDurationUs(project) / 1e6;
    if (!el || dur <= 0) return;
    useEditor.getState().setZoom((el.clientWidth - HEADER_W - 40) / dur);
  };
  return (
    <div className="tl-toolbar" role="toolbar" aria-label="Timeline tools">
      <button className="btn btn-sm" onClick={splitAtPlayhead} title="Split at playhead (S)" data-testid="split">
        <Icon name="split" size={14} /> Split
      </button>
      <button className="btn btn-sm" onClick={() => deleteSelection()} disabled={!hasSel} title="Delete selected (Del)" data-testid="delete">
        <Icon name="trash" size={14} /> Delete
      </button>
      <button className="btn btn-sm" onClick={() => deleteSelection(true)} disabled={!hasSel} title="Delete and close the gap (Shift+Del)">
        Ripple delete
      </button>
      <button className="btn btn-sm" onClick={duplicateSelection} disabled={!hasSel} title="Duplicate (Ctrl+D)">
        <Icon name="dup" size={14} /> Duplicate
      </button>
      <span className="tl-sep" />
      <button className={`btn btn-sm ${snapping ? 'active' : ''}`} aria-pressed={snapping} onClick={() => set({ snapping: !snapping })} title="Snap to playhead, clip edges and start (N)">
        <Icon name="magnet" size={14} /> Snap
      </button>
      <span className="tl-sep" />
      <button className="icon-btn" onClick={() => useEditor.getState().setZoom(zoom / 1.25)} aria-label="Zoom out" title="Zoom out (-)">
        <Icon name="zoomOut" />
      </button>
      <input type="range" min={4} max={800} value={zoom} onChange={(e) => useEditor.getState().setZoom(Number(e.target.value))} aria-label="Timeline zoom" className="zoom-slider" />
      <button className="icon-btn" onClick={() => useEditor.getState().setZoom(zoom * 1.25)} aria-label="Zoom in" title="Zoom in (+)">
        <Icon name="zoomIn" />
      </button>
      <button className="btn btn-sm" onClick={fit} title="Fit timeline to view">
        Fit
      </button>
      <span className="tl-sep" />
      <button className="btn btn-sm" onClick={() => useEditor.getState().edit('Add video track', (p) => cmd.addTrack(p, { kind: 'video' }))}>
        + Video track
      </button>
      <button className="btn btn-sm" onClick={() => useEditor.getState().edit('Add audio track', (p) => cmd.addTrack(p, { kind: 'audio' }))}>
        + Audio track
      </button>
    </div>
  );
}

function TrackHeader({ track, project }: { track: Track; project: Project }) {
  const edit = useEditor((s) => s.edit);
  const sameKind = project.tracks.filter((t) => t.kind === track.kind);
  const idx = sameKind.findIndex((t) => t.id === track.id);
  const toggle = (k: 'muted' | 'hidden' | 'locked') => edit(`${k === 'muted' ? (track.muted ? 'Unmute' : 'Mute') : k === 'hidden' ? (track.hidden ? 'Show' : 'Hide') : track.locked ? 'Unlock' : 'Lock'} ${track.name}`, (p) => cmd.updateTrack(p, { trackId: track.id, patch: { [k]: !track[k] } }));
  const remove = async () => {
    if (track.clips.length && !(await confirmDialog({ title: `Delete track ${track.name}?`, message: `It contains ${track.clips.length} clip(s). You can undo this.`, confirmLabel: 'Delete track', danger: true }))) return;
    edit(`Delete track ${track.name}`, (p) => cmd.removeTrack(p, { trackId: track.id }));
  };
  return (
    <div className="track-header">
      <span className="track-name" title={track.kind === 'video' ? 'Visual track — upper tracks draw on top' : 'Audio track'}>
        <Icon name={track.kind === 'video' ? 'film' : 'music'} size={13} /> {track.name}
      </span>
      <span className="track-btns">
        {track.kind === 'video' && (
          <button className={`icon-btn xs ${track.hidden ? 'on' : ''}`} aria-pressed={track.hidden} aria-label={`${track.hidden ? 'Show' : 'Hide'} ${track.name}`} title={track.hidden ? 'Show track' : 'Hide track'} onClick={() => toggle('hidden')}>
            <Icon name={track.hidden ? 'eyeOff' : 'eye'} size={13} />
          </button>
        )}
        <button className={`icon-btn xs ${track.muted ? 'on' : ''}`} aria-pressed={track.muted} aria-label={`${track.muted ? 'Unmute' : 'Mute'} ${track.name}`} title={track.muted ? 'Unmute track' : 'Mute track'} onClick={() => toggle('muted')}>
          <Icon name={track.muted ? 'mute' : 'volume'} size={13} />
        </button>
        <button className={`icon-btn xs ${track.locked ? 'on' : ''}`} aria-pressed={track.locked} aria-label={`${track.locked ? 'Unlock' : 'Lock'} ${track.name}`} title={track.locked ? 'Unlock track' : 'Lock track'} onClick={() => toggle('locked')}>
          <Icon name={track.locked ? 'lock' : 'unlock'} size={13} />
        </button>
        <button className="icon-btn xs" disabled={idx <= 0} aria-label={`Move ${track.name} up`} title={track.kind === 'video' ? 'Move up (draw on top)' : 'Move up'} onClick={() => edit('Reorder tracks', (p) => cmd.reorderTrack(p, { trackId: track.id, direction: -1 }))}>
          <Icon name="up" size={12} />
        </button>
        <button className="icon-btn xs" disabled={idx >= sameKind.length - 1} aria-label={`Move ${track.name} down`} title="Move down" onClick={() => edit('Reorder tracks', (p) => cmd.reorderTrack(p, { trackId: track.id, direction: 1 }))}>
          <Icon name="down" size={12} />
        </button>
        {sameKind.length > 1 && (
          <button className="icon-btn xs" aria-label={`Delete ${track.name}`} title="Delete track" onClick={remove}>
            <Icon name="x" size={12} />
          </button>
        )}
      </span>
    </div>
  );
}

const ClipView = memo(function ClipView({
  clip,
  track,
  left,
  width,
  offsetY,
  selected,
  dragging,
  onPointerDown,
  zoom,
}: {
  clip: Clip;
  track: Track;
  left: number;
  width: number;
  offsetY: number;
  selected: boolean;
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent, clip: Clip, track: Track, edge: 'start' | 'end' | null) => void;
  zoom: number;
}) {
  const assets = useEditor((s) => s.assets);
  const asset = clip.kind === 'text' ? null : assets.find((a) => a.id === clip.assetId);
  const missing = clip.kind !== 'text' && !asset;
  const label = clip.kind === 'text' ? clip.text.split('\n')[0] || 'Text' : clip.name || asset?.name || 'Clip';
  const fadeInW = (clip.fadeInUs / 1e6) * zoom;
  const fadeOutW = (clip.fadeOutUs / 1e6) * zoom;
  const transition = (clip.kind === 'video' || clip.kind === 'image') && clip.transitionIn;
  const thumb = asset?.metadata.hasThumbnail ? `url(${assetThumbUrl(asset.id)})` : undefined;
  const showWave = (clip.kind === 'audio' || clip.kind === 'video') && asset?.metadata.peaks?.length;
  return (
    <div
      className={`clip clip-${clip.kind} ${selected ? 'selected' : ''} ${dragging ? 'dragging' : ''} ${missing ? 'missing' : ''} ${(clip.kind === 'audio' || clip.kind === 'video') && clip.muted ? 'muted' : ''}`}
      style={{ left, width, transform: offsetY ? `translateY(${offsetY}px)` : undefined }}
      onPointerDown={(e) => onPointerDown(e, clip, track, null)}
      data-testid="clip"
      data-clip-id={clip.id}
      data-clip-kind={clip.kind}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${clip.kind} clip ${label}, ${formatShort(clip.timelineStartUs)} to ${formatShort(clipEndUs(clip))}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter') useEditor.getState().set({ selection: [clip.id] });
      }}
    >
      {clip.kind === 'video' || clip.kind === 'image' ? <div className="clip-thumbs" style={{ backgroundImage: thumb }} /> : null}
      {showWave ? <Waveform peaks={asset!.metadata.peaks!} assetDurUs={asset!.metadata.durationUs ?? 1} sourceStartUs={clip.sourceStartUs} spanUs={clip.durationUs * (clip.kind === 'audio' || clip.kind === 'video' ? clip.speed : 1)} width={width} small={clip.kind === 'video'} /> : null}
      <div className="clip-label">
        {transition && <span className="clip-badge" title={`${transition.type} transition`}>⧓</span>}
        {missing ? '⚠ Missing media · ' : ''}
        {label}
        {(clip.kind === 'video' || clip.kind === 'audio') && clip.speed !== 1 ? ` · ${clip.speed}×` : ''}
      </div>
      {fadeInW > 1 && <div className="fade fade-in" style={{ width: fadeInW }} />}
      {fadeOutW > 1 && <div className="fade fade-out" style={{ width: fadeOutW }} />}
      {!track.locked && (
        <>
          <div className="trim-handle left" onPointerDown={(e) => onPointerDown(e, clip, track, 'start')} aria-hidden title="Drag to trim start" />
          <div className="trim-handle right" onPointerDown={(e) => onPointerDown(e, clip, track, 'end')} aria-hidden title="Drag to trim end" />
        </>
      )}
    </div>
  );
});

function Waveform({ peaks, assetDurUs, sourceStartUs, spanUs, width, small }: { peaks: number[]; assetDurUs: number; sourceStartUs: number; spanUs: number; width: number; small?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const w = Math.min(4000, Math.max(1, Math.round(width)));
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const h = c.height;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = small ? 'rgba(160,255,200,0.55)' : 'rgba(120,230,170,0.9)';
    const n = peaks.length;
    for (let x = 0; x < w; x++) {
      const tUs = sourceStartUs + (spanUs * x) / w;
      const i = Math.floor((tUs / assetDurUs) * n);
      const v = i >= 0 && i < n ? peaks[i] : 0;
      const bh = Math.max(1, v * h * 0.95);
      ctx.fillRect(x, (h - bh) / 2, 1, bh);
    }
  }, [peaks, assetDurUs, sourceStartUs, spanUs, w, small]);
  return <canvas ref={ref} className={`waveform ${small ? 'small' : ''}`} width={w} height={small ? 18 : 36} style={{ width }} aria-hidden />;
}

function RulerTicks({ zoom, seconds }: { zoom: number; seconds: number }) {
  // Choose a major tick interval giving ≥ 70px spacing.
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const major = steps.find((s) => s * zoom >= 70) ?? 600;
  const minor = major / 5;
  const ticks: React.ReactNode[] = [];
  const n = Math.ceil(seconds / minor);
  for (let i = 0; i <= n; i++) {
    const s = i * minor;
    const isMajor = Math.abs(s / major - Math.round(s / major)) < 1e-6;
    ticks.push(
      <div key={i} className={`tick ${isMajor ? 'major' : ''}`} style={{ left: s * zoom }}>
        {isMajor && <span>{formatShort(s * 1e6)}</span>}
      </div>,
    );
  }
  return <>{ticks}</>;
}

function Playhead({ zoom }: { zoom: number }) {
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.playing);
  const ref = useRef<HTMLDivElement>(null);
  const x = HEADER_W + (playhead / 1e6) * zoom;
  useEffect(() => {
    if (!playing) return;
    const sc = document.querySelector('.tl-scroll') as HTMLElement | null;
    if (!sc) return;
    if (x > sc.scrollLeft + sc.clientWidth - 60 || x < sc.scrollLeft + HEADER_W) sc.scrollLeft = x - HEADER_W - 40;
  }, [x, playing]);
  return (
    <div className="playhead" ref={ref} style={{ left: x }} data-testid="playhead">
      <div className="playhead-knob" />
    </div>
  );
}

void getAssetIndex;

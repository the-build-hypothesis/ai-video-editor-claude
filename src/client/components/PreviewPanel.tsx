import { useEffect, useRef, useState } from 'react';
import { useEditor, getAssetIndex } from '../store';
import { PreviewEngine } from '../engine/preview';
import { player, togglePlay, seek, stepFrames } from '../actions';
import { Icon } from './ui';
import { formatTimecode } from '../../shared/time';
import { projectDurationUs, findClip, ASPECT_PRESETS, type AspectPreset } from '../../shared/model';
import { setTransformAt, updateSettings } from '../../shared/commands';
import { effectiveTransform } from '../../shared/timeline-eval';

export function PreviewPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const project = useEditor((s) => s.project)!;
  const assets = useEditor((s) => s.assets);
  const selection = useEditor((s) => s.selection);
  const playing = useEditor((s) => s.playing);
  const [quality, setQuality] = useState(0.5);
  const [guides, setGuides] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  // Engine lifecycle
  useEffect(() => {
    const engine = new PreviewEngine(canvasRef.current!, hostRef.current!);
    player.engine = engine;
    let last = 0;
    engine.onTime = (t) => {
      const now = performance.now();
      if (now - last > 50 || !engine.playing) {
        last = now;
        useEditor.getState().setPlayhead(t);
      }
    };
    engine.onEnded = () => useEditor.getState().setPlaying(false);
    engine.onStatus = setStatus;
    engine.seek(useEditor.getState().playhead);
    return () => {
      engine.dispose();
      if (player.engine === engine) player.engine = null;
    };
  }, []);

  useEffect(() => {
    player.engine?.setProject(project, getAssetIndex());
  }, [project, assets]);

  useEffect(() => {
    player.engine?.setOptions({ quality, guides, selectedClipIds: selection });
  }, [quality, guides, selection]);

  // Fit the frame inside the stage while keeping the project aspect ratio.
  useEffect(() => {
    const el = stageRef.current!;
    const ro = new ResizeObserver(() => {
      const W = el.clientWidth - 16;
      const H = el.clientHeight - 16;
      const ar = project.settings.width / project.settings.height;
      let w = W;
      let h = W / ar;
      if (h > H) {
        h = H;
        w = H * ar;
      }
      setBox({ w: Math.max(0, Math.floor(w)), h: Math.max(0, Math.floor(h)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [project.settings.width, project.settings.height]);

  // Direct manipulation: drag selected visual clip to reposition.
  const dragRef = useRef<{ clipId: string; startX: number; startY: number; ox: number; oy: number; scale: number; localUs: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    const st = useEditor.getState();
    if (st.selection.length !== 1 || st.playing) return;
    const f = findClip(project, st.selection[0]);
    if (!f || f.clip.kind === 'audio' || f.track.locked) return;
    const scale = project.settings.width / box.w;
    const localUs = Math.max(0, Math.min(f.clip.durationUs, st.playhead - f.clip.timelineStartUs));
    const cur = effectiveTransform(f.clip, localUs);
    dragRef.current = { clipId: f.clip.id, startX: e.clientX, startY: e.clientY, ox: cur.x, oy: cur.y, scale, localUs };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const x = Math.round(d.ox + (e.clientX - d.startX) * d.scale);
    const y = Math.round(d.oy + (e.clientY - d.startY) * d.scale);
    try {
      const temp = setTransformAt(project, { clipId: d.clipId, localUs: d.localUs, patch: { x, y } });
      player.engine?.setProject(temp, getAssetIndex());
    } catch {
      /* ignore during drag */
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    const dx = Math.round((e.clientX - d.startX) * d.scale);
    const dy = Math.round((e.clientY - d.startY) * d.scale);
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) {
      player.engine?.setProject(project, getAssetIndex());
      return;
    }
    useEditor.getState().edit('Move on canvas', (p) => setTransformAt(p, { clipId: d.clipId, localUs: d.localUs, patch: { x: d.ox + dx, y: d.oy + dy } }));
  };

  const setAspect = (a: AspectPreset) => {
    useEditor.getState().edit(`Aspect ${a}`, (p) => updateSettings(p, { patch: {}, aspect: a }));
  };
  const currentAspect = (Object.keys(ASPECT_PRESETS) as AspectPreset[]).find((k) => ASPECT_PRESETS[k].width === project.settings.width && ASPECT_PRESETS[k].height === project.settings.height);

  return (
    <div className="preview">
      <div className="preview-stage" ref={stageRef}>
        <div className="preview-frame" ref={frameRef} style={{ width: box.w, height: box.h }}>
          <canvas
            ref={canvasRef}
            className="preview-canvas"
            data-testid="preview-canvas"
            aria-label="Composition preview"
            role="img"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={() => frameRef.current?.requestFullscreen?.()}
          />
          {projectDurationUs(project) === 0 && (
            <div className="preview-empty">
              <p>Import media on the left, then click <strong>+</strong> or drag it onto the timeline.</p>
            </div>
          )}
          {status && <div className="preview-status">{status}</div>}
        </div>
        <div ref={hostRef} hidden />
      </div>
      <Transport playing={playing} />
      <div className="preview-options">
        <label className="inline-field">
          <span>Aspect</span>
          <select className="input input-sm" value={currentAspect ?? 'custom'} onChange={(e) => setAspect(e.target.value as AspectPreset)} aria-label="Aspect ratio preset">
            {!currentAspect && <option value="custom">Custom</option>}
            {(Object.keys(ASPECT_PRESETS) as AspectPreset[]).map((k) => (
              <option key={k} value={k}>
                {k} ({ASPECT_PRESETS[k].width}×{ASPECT_PRESETS[k].height})
              </option>
            ))}
          </select>
        </label>
        <label className="inline-field">
          <span>Preview quality</span>
          <select className="input input-sm" value={quality} onChange={(e) => setQuality(Number(e.target.value))} aria-label="Preview quality">
            <option value={1}>Full</option>
            <option value={0.5}>Half</option>
            <option value={0.25}>Quarter</option>
          </select>
        </label>
        <button className={`btn btn-sm ${guides ? 'active' : ''}`} aria-pressed={guides} onClick={() => setGuides(!guides)} title="Safe-area guides">
          <Icon name="grid" size={14} /> Guides
        </button>
        <button className="btn btn-sm" onClick={() => frameRef.current?.requestFullscreen?.()} title="Fullscreen preview">
          <Icon name="fullscreen" size={14} /> Fullscreen
        </button>
      </div>
    </div>
  );
}

function Transport({ playing }: { playing: boolean }) {
  const playhead = useEditor((s) => s.playhead);
  const project = useEditor((s) => s.project)!;
  const dur = projectDurationUs(project);
  const fps = project.settings.fps;
  return (
    <div className="transport">
      <button className="icon-btn" onClick={() => seek(0)} aria-label="Go to start" title="Go to start (Home)">
        <Icon name="back" />
      </button>
      <button className="icon-btn" onClick={() => stepFrames(-1)} aria-label="Previous frame" title="Previous frame (←)">
        ‹
      </button>
      <button className="play-btn" onClick={() => void togglePlay()} aria-label={playing ? 'Pause' : 'Play'} title="Play/Pause (Space)" data-testid="play">
        <Icon name={playing ? 'pause' : 'play'} size={20} />
      </button>
      <button className="icon-btn" onClick={() => stepFrames(1)} aria-label="Next frame" title="Next frame (→)">
        ›
      </button>
      <div className="timecode" aria-label="Current time and duration">
        <span data-testid="current-time">{formatTimecode(playhead, fps)}</span>
        <span className="muted"> / {formatTimecode(dur, fps)}</span>
      </div>
    </div>
  );
}

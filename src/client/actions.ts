import * as cmd from '../shared/commands';
import { type AssetDTO } from '../shared/api-types';
import { clipEndUs, findClip, projectDurationUs, type Project } from '../shared/model';
import { snapToFrame } from '../shared/time';
import { getAssetIndex, useEditor } from './store';
import type { PreviewEngine } from './engine/preview';

// ------------------------------------------------------------------ player controller
export const player: { engine: PreviewEngine | null } = { engine: null };

export function seek(t: number) {
  const st = useEditor.getState();
  const p = st.project;
  const fps = p?.settings.fps ?? 30;
  const dur = p ? projectDurationUs(p) : 0;
  const v = snapToFrame(Math.max(0, Math.min(t, Math.max(dur, 0))), fps);
  player.engine?.seek(v);
  st.setPlayhead(v);
}

export async function togglePlay() {
  const e = player.engine;
  if (!e) return;
  if (e.playing) {
    e.pause();
    useEditor.getState().setPlaying(false);
  } else {
    e.seek(useEditor.getState().playhead);
    await e.play();
    useEditor.getState().setPlaying(e.playing);
  }
}

export function pause() {
  if (player.engine?.playing) {
    player.engine.pause();
    useEditor.getState().setPlaying(false);
  }
}

export function stepFrames(n: number) {
  const st = useEditor.getState();
  const fps = st.project?.settings.fps ?? 30;
  pause();
  seek(st.playhead + (n * 1e6) / fps);
}

// ------------------------------------------------------------------ edits
export function addAssetToTimeline(asset: AssetDTO, opts?: { trackId?: string; atUs?: number }) {
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return;
  if (asset.status !== 'ready') {
    st.toast('error', `"${asset.name}" is not ready yet (status: ${asset.status}).`);
    return;
  }
  const idx = getAssetIndex();
  const info = idx[asset.id];
  const wantKind = asset.kind === 'audio' ? 'audio' : 'video';
  let track = opts?.trackId ? p.tracks.find((t) => t.id === opts.trackId) : undefined;
  if (track && track.kind !== wantKind) {
    st.toast('error', `${asset.kind === 'audio' ? 'Audio' : 'Visual'} media must go on a${wantKind === 'audio' ? 'n audio' : ' video'} track.`);
    return;
  }
  if (!track) {
    // Default: lowest unlocked track of the right kind (V1 for video, A1 for audio).
    const candidates = p.tracks.filter((t) => t.kind === wantKind && !t.locked);
    track = wantKind === 'video' ? candidates[candidates.length - 1] : candidates[0];
  }
  if (!track) {
    st.toast('error', 'No unlocked track available.');
    return;
  }
  // Default position: end of the target track (append), or explicit drop position.
  const at = opts?.atUs ?? track.clips.reduce((m, c) => Math.max(m, clipEndUs(c)), 0);
  const clip = cmd.makeClipForAsset(info, snapToFrame(at, p.settings.fps), p);
  st.edit(`Add ${asset.name}`, (pp, ctx) => cmd.addClip(pp, { trackId: track!.id, clip }, ctx), { select: [clip.id] });
}

export function addTextPreset(kind: 'title' | 'lowerThird' | 'subtitle' | 'text') {
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return;
  const H = p.settings.height;
  const W = p.settings.width;
  const presets = {
    title: { text: 'Your Title', y: 0, style: { fontSize: Math.round(H * 0.1), bold: true }, animation: 'fade' as const, dur: 3e6 },
    lowerThird: { text: 'Name Surname\nTitle or role', y: H * 0.3, x: -W * 0.22, style: { fontSize: Math.round(H * 0.045), background: '#000000aa', align: 'left' as const, shadow: false }, animation: 'slideUp' as const, dur: 4e6 },
    subtitle: { text: 'Subtitle text', y: H * 0.38, style: { fontSize: Math.round(H * 0.05), background: '#00000099', bold: false, shadow: false }, animation: 'none' as const, dur: 3e6 },
    text: { text: 'Text', y: 0, style: { fontSize: Math.round(H * 0.07) }, animation: 'none' as const, dur: 3e6 },
  }[kind];
  const clip = cmd.makeTextClip({
    text: presets.text,
    timelineStartUs: snapToFrame(st.playhead, p.settings.fps),
    durationUs: presets.dur,
    y: presets.y,
    x: 'x' in presets ? presets.x : 0,
    style: presets.style,
    animation: presets.animation,
    preset: kind,
  });
  const track = p.tracks.find((t) => t.kind === 'video' && !t.locked);
  if (!track) return st.toast('error', 'No unlocked visual track for text.');
  st.edit('Add text', (pp, ctx) => cmd.addClip(pp, { trackId: track.id, clip }, ctx), { select: [clip.id] });
  st.set({ rightTab: 'inspector' });
}

export function splitAtPlayhead() {
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return;
  const t = st.playhead;
  // Split selected clips under the playhead; if none selected, split all unlocked clips under the playhead.
  let targets = st.selection.map((id) => findClip(p, id)).filter((f) => f && t > f.clip.timelineStartUs && t < clipEndUs(f.clip));
  if (targets.length === 0) {
    targets = p.tracks.filter((tr) => !tr.locked).flatMap((tr) => tr.clips.filter((c) => t > c.timelineStartUs && t < clipEndUs(c)).map((c) => findClip(p, c.id)));
  }
  if (targets.length === 0) {
    st.toast('info', 'Move the playhead over a clip to split it.');
    return;
  }
  st.edit('Split', (pp) => targets.reduce((acc, f) => cmd.splitClip(acc, { clipId: f!.clip.id, atUs: t }), pp));
}

export function deleteSelection(ripple = false) {
  const st = useEditor.getState();
  if (st.selectedCaption && st.selection.length === 0) {
    const id = st.selectedCaption;
    st.edit('Delete caption', (p) => cmd.removeCaption(p, { id }));
    st.set({ selectedCaption: null });
    return;
  }
  if (!st.selection.length) return;
  const ids = [...st.selection];
  if (ripple && ids.length === 1) st.edit('Ripple delete', (p) => cmd.rippleDelete(p, { clipId: ids[0] }), { select: [] });
  else st.edit(ids.length > 1 ? `Delete ${ids.length} clips` : 'Delete clip', (p) => cmd.removeClips(p, { clipIds: ids }), { select: [] });
}

export function duplicateSelection() {
  const st = useEditor.getState();
  if (!st.selection.length) return;
  const newIds: string[] = [];
  st.edit('Duplicate', (p) =>
    st.selection.reduce((acc, id) => {
      const nid = `c_${Math.random().toString(36).slice(2, 11)}`;
      newIds.push(nid);
      return cmd.duplicateClip(acc, { clipId: id, newId: nid });
    }, p),
  );
  st.select(newIds);
}

export function copySelection() {
  const st = useEditor.getState();
  const p = st.project;
  if (!p || !st.selection.length) return;
  const items = st.selection.map((id) => findClip(p, id)).filter(Boolean).map((f) => ({ trackId: f!.track.id, clip: structuredClone(f!.clip) }));
  st.set({ clipboard: items });
  st.toast('info', `Copied ${items.length} clip${items.length > 1 ? 's' : ''}`);
}

export function pasteClipboard() {
  const st = useEditor.getState();
  if (!st.clipboard.length) return;
  const before = new Set(allClipIds(st.project));
  const ok = st.edit('Paste', (p, ctx) => cmd.pasteClips(p, { clips: st.clipboard, atUs: st.playhead }, ctx));
  if (ok) st.select(allClipIds(useEditor.getState().project).filter((id) => !before.has(id)));
}

function allClipIds(p: Project | null): string[] {
  return p ? p.tracks.flatMap((t) => t.clips.map((c) => c.id)) : [];
}

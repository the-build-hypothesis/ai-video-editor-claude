/**
 * Timeline evaluation shared by preview and export (PREV-03). Given a project and a timeline time t
 * (µs), returns the ordered list of visual layers to composite and the audio segments to mix.
 * Pure functions: no DOM / canvas access, so they are unit-tested directly.
 */
import {
  type AssetIndex,
  type CaptionSegment,
  type Clip,
  type Project,
  type TextClip,
  type Track,
  type VisualClip,
  type Transition,
  clipEndUs,
  clipSpeed,
} from './model';
import { frameCount } from './time';

export interface VisualLayer {
  clip: VisualClip;
  track: Track;
  /** Source time to sample (µs) for video clips; may fall outside media → renderer clamps (hold frame). */
  sourceUs: number;
  /** Time since clip start (µs); negative during transition pre-roll. */
  localUs: number;
  /** Combined opacity multiplier from fades and transitions (does not include transform.opacity). */
  opacity: number;
  /** Wipe reveal: fraction of the frame width revealed, from left ('wipeleft') or right ('wiperight'). */
  wipe: { from: 'left' | 'right'; progress: number } | null;
}

export function fadeFactor(clip: Clip, t: number): number {
  const local = t - clip.timelineStartUs;
  const remain = clipEndUs(clip) - t;
  let f = 1;
  if (clip.fadeInUs > 0 && local < clip.fadeInUs) f = Math.min(f, Math.max(0, local / clip.fadeInUs));
  if (clip.fadeOutUs > 0 && remain < clip.fadeOutUs) f = Math.min(f, Math.max(0, remain / clip.fadeOutUs));
  return f;
}

export function sourceTimeAt(clip: Clip, t: number): number {
  if (clip.kind === 'text') return 0;
  return Math.round(clip.sourceStartUs + (t - clip.timelineStartUs) * clipSpeed(clip));
}

/** Tolerance for "adjacent" clips when looking up a transition predecessor. */
export const ADJACENCY_TOLERANCE_US = 20_000;

export function findTransitionPredecessor(track: Track, clip: Clip): Clip | null {
  let best: Clip | null = null;
  for (const c of track.clips) {
    if (c.id === clip.id || c.kind === 'text' || c.kind === 'audio') continue;
    if (Math.abs(clipEndUs(c) - clip.timelineStartUs) <= ADJACENCY_TOLERANCE_US && c.timelineStartUs < clip.timelineStartUs) {
      if (!best || c.timelineStartUs > best.timelineStartUs) best = c;
    }
  }
  return best;
}

function transitionOf(c: Clip): Transition | null {
  return c.kind === 'video' || c.kind === 'image' ? c.transitionIn : null;
}

/**
 * Visual layers bottom→top at time t.
 * Track order: project.tracks earlier = on top, so we iterate in reverse.
 * Within a track: later timelineStartUs on top.
 * Transition on clip B (centered on the cut between predecessor A and B, duration d):
 *   window [cut - d/2, cut + d/2), progress q = (t - (cut - d/2)) / d.
 *   A is extended past its out point (renderer holds its last frame if source runs out) and B is
 *   pre-rolled before its in point (holds first frame if source starts at 0).
 *   dissolve: A at 1, B at q.   fadeblack: A at 1-2q (q<.5), B at 2q-1 (q≥.5).   wipe: B revealed by q.
 */
export function evaluateVisualLayers(p: Project, t: number): VisualLayer[] {
  const layers: VisualLayer[] = [];
  for (let ti = p.tracks.length - 1; ti >= 0; ti--) {
    const track = p.tracks[ti];
    if (track.kind !== 'video' || track.hidden) continue;
    const trackLayers: (VisualLayer & { order: number })[] = [];
    const push = (clip: VisualClip, opacity: number, wipe: VisualLayer['wipe'], order: number) => {
      trackLayers.push({ clip, track, sourceUs: sourceTimeAt(clip, t), localUs: t - clip.timelineStartUs, opacity, wipe, order });
    };
    const handled = new Set<string>();
    // Transitions first, so we know which clips are part of a transition at t.
    for (const b of track.clips) {
      const tr = transitionOf(b);
      if (!tr || b.kind === 'audio') continue;
      const a = findTransitionPredecessor(track, b);
      if (!a || a.kind === 'audio') continue;
      const cut = b.timelineStartUs;
      const half = Math.floor(tr.durationUs / 2);
      const w0 = cut - half;
      const w1 = cut + (tr.durationUs - half);
      if (t < w0 || t >= w1) continue;
      const q = (t - w0) / tr.durationUs;
      const aF = t < clipEndUs(a) ? fadeFactor(a, t) : 1;
      const bF = t >= cut ? fadeFactor(b, t) : 1;
      let aOp = aF;
      let bOp = bF;
      let wipe: VisualLayer['wipe'] = null;
      if (tr.type === 'dissolve') bOp = bF * q;
      else if (tr.type === 'fadeblack') {
        aOp = q < 0.5 ? aF * (1 - 2 * q) : 0;
        bOp = q >= 0.5 ? bF * (2 * q - 1) : 0;
      } else wipe = { from: tr.type === 'wipeleft' ? 'left' : 'right', progress: q };
      if (aOp > 0) push(a as VisualClip, aOp, null, a.timelineStartUs);
      if (bOp > 0) push(b as VisualClip, bOp, wipe, b.timelineStartUs);
      handled.add(a.id);
      handled.add(b.id);
    }
    for (const c of track.clips) {
      if (c.kind === 'audio' || handled.has(c.id)) continue;
      if (t >= c.timelineStartUs && t < clipEndUs(c)) {
        const f = fadeFactor(c, t);
        if (f > 0) push(c, f, null, c.timelineStartUs);
      }
    }
    trackLayers.sort((x, y) => x.order - y.order);
    for (const l of trackLayers) {
      const { order: _o, ...rest } = l;
      void _o;
      layers.push(rest);
    }
  }
  return layers;
}

export function activeCaption(p: Project, t: number): CaptionSegment | null {
  for (const s of p.captions.segments) if (t >= s.startUs && t < s.endUs) return s;
  return null;
}

/** Text animation state for a text clip at local time. */
export function textAnimation(clip: TextClip, localUs: number): { opacity: number; dy: number; scale: number; chars: number } {
  const total = clip.durationUs;
  const remain = total - localUs;
  const ramp = Math.min(400_000, total / 4);
  let opacity = 1;
  let dy = 0;
  let scale = 1;
  let chars = clip.text.length;
  switch (clip.animation) {
    case 'fade':
      opacity = Math.min(1, localUs / ramp, remain / ramp);
      break;
    case 'slideUp': {
      const k = Math.min(1, localUs / ramp);
      dy = (1 - easeOut(k)) * 60;
      opacity = Math.min(k, remain / ramp);
      break;
    }
    case 'pop': {
      const k = Math.min(1, localUs / ramp);
      scale = 0.6 + 0.4 * easeOutBack(k);
      opacity = Math.min(1, k * 2, remain / ramp);
      break;
    }
    case 'typewriter': {
      const typeDur = Math.min(total * 0.5, 40_000 * clip.text.length);
      chars = typeDur <= 0 ? clip.text.length : Math.min(clip.text.length, Math.floor((localUs / typeDur) * clip.text.length));
      break;
    }
  }
  return { opacity: Math.max(0, Math.min(1, opacity)), dy, scale, chars };
}

function easeOut(k: number) {
  return 1 - Math.pow(1 - k, 3);
}
function easeOutBack(k: number) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
}

// ------------------------------------------------------------------ audio

export interface AudioSegment {
  clipId: string;
  assetId: string;
  timelineStartUs: number;
  durationUs: number;
  sourceStartUs: number;
  speed: number;
  /** Static gain = clip.volume × track.volume. */
  gain: number;
  fadeInUs: number;
  fadeOutUs: number;
  gainPoints: { tUs: number; gain: number }[];
}

/**
 * Audio mix plan. Audio tracks contribute their audio clips; visual tracks contribute the audio of
 * video clips whose asset has audio. Track.muted / clip.muted silence; track.hidden does NOT mute.
 * Mixing policy (AUD-05): sum all segments, apply settings.masterVolume, then a fast limiter
 * (DynamicsCompressor, threshold -1 dBFS, ratio 20) — identical graph in preview and export.
 */
export function audioSegments(p: Project, assets: AssetIndex): AudioSegment[] {
  const out: AudioSegment[] = [];
  for (const track of p.tracks) {
    if (track.muted) continue;
    for (const c of track.clips) {
      if (c.kind !== 'audio' && c.kind !== 'video') continue;
      if (c.muted || c.volume <= 0) continue;
      const a = assets[c.assetId];
      if (!a || (c.kind === 'video' && !a.hasAudio)) continue;
      out.push({
        clipId: c.id,
        assetId: c.assetId,
        timelineStartUs: c.timelineStartUs,
        durationUs: c.durationUs,
        sourceStartUs: c.sourceStartUs,
        speed: c.speed,
        gain: c.volume * track.volume,
        fadeInUs: c.fadeInUs,
        fadeOutUs: c.fadeOutUs,
        gainPoints: c.gainPoints,
      });
    }
  }
  return out;
}

/** Gain of a segment at timeline time t (fades × automation × static gain). */
export function segmentGainAt(s: AudioSegment, t: number): number {
  const local = t - s.timelineStartUs;
  if (local < 0 || local >= s.durationUs) return 0;
  let g = s.gain;
  if (s.fadeInUs > 0 && local < s.fadeInUs) g *= local / s.fadeInUs;
  const remain = s.durationUs - local;
  if (s.fadeOutUs > 0 && remain < s.fadeOutUs) g *= remain / s.fadeOutUs;
  if (s.gainPoints.length) g *= interpGain(s.gainPoints, local);
  return g;
}

export function interpGain(points: { tUs: number; gain: number }[], local: number): number {
  if (points.length === 0) return 1;
  if (local <= points[0].tUs) return points[0].gain;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (local <= b.tUs) {
      const span = b.tUs - a.tUs;
      return span <= 0 ? b.gain : a.gain + ((b.gain - a.gain) * (local - a.tUs)) / span;
    }
  }
  return points[points.length - 1].gain;
}

/** Export plan summary used for job metadata and consistency tests. */
export function exportPlan(p: Project, assets: AssetIndex, opts: { width: number; height: number; fps: number }) {
  let end = 0;
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, clipEndUs(c));
  const frames = frameCount(end, opts.fps);
  return {
    durationUs: end,
    frames,
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    audioSegments: audioSegments(p, assets),
    usedAssetIds: [...new Set(p.tracks.flatMap((t) => t.clips.filter((c) => c.kind !== 'text').map((c) => (c as Exclude<Clip, TextClip>).assetId)))],
  };
}

/**
 * Edit command layer. Every command is a pure function (project, args, ctx) -> new project.
 * Manual UI edits and AI-proposed operations both go through these functions, so validation,
 * undo/redo (snapshot based, see client store) and serialization behave identically.
 *
 * Same-track overlap policy: clips on one track MAY overlap. Visual: the clip with the later
 * timelineStartUs is drawn on top (ties: later array position). Audio: overlapping clips are mixed.
 * Track order: visual tracks earlier in project.tracks are composited on top of later ones.
 */
import { keyframeValuesAt, effectiveTransform } from './timeline-eval';
import {
  type AssetIndex,
  type Clip,
  type Project,
  type Track,
  type TextClip,
  type Transition,
  type Transform,
  ProjectSchema,
  ClipSchema,
  TextStyleSchema,
  TransformSchema,
  clipEndUs,
  clipSpeed,
  findClip,
  newId,
  type CaptionSegment,
  type Settings,
  ASPECT_PRESETS,
  type AspectPreset,
  CaptionsSchema,
} from './model';
import { interpGain } from './timeline-eval';

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}

export interface CommandContext {
  assets: AssetIndex;
}

const MIN_DURATION_US = 1000 * 33; // ~1 frame at 30 fps

function clone<T>(v: T): T {
  return structuredClone(v);
}

function finalize(p: Project): Project {
  for (const t of p.tracks) t.clips.sort((a, b) => a.timelineStartUs - b.timelineStartUs || 0);
  const r = ProjectSchema.safeParse(p);
  if (!r.success) throw new CommandError('Invalid project after edit: ' + r.error.issues.map((i) => i.message).join('; '));
  return r.data;
}

function requireTrack(p: Project, trackId: string): Track {
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t) throw new CommandError(`Track ${trackId} not found`);
  return t;
}

function requireClip(p: Project, clipId: string) {
  const f = findClip(p, clipId);
  if (!f) throw new CommandError(`Clip ${clipId} not found`);
  if (f.track.locked) throw new CommandError(`Track ${f.track.name} is locked`);
  return f;
}

/** Source duration (µs) available for a media clip, or Infinity for images/text. */
export function sourceDurationUs(clip: Clip, ctx: CommandContext): number {
  if (clip.kind === 'text' || clip.kind === 'image') return Infinity;
  const a = ctx.assets[clip.assetId];
  return a?.durationUs ?? Infinity;
}

/** Max timeline duration a clip can have given its sourceStart and speed. */
export function maxDurationUs(clip: Clip, ctx: CommandContext): number {
  const src = sourceDurationUs(clip, ctx);
  if (!isFinite(src)) return Infinity;
  const sourceStart = clip.kind === 'text' ? 0 : clip.sourceStartUs;
  return Math.floor((src - sourceStart) / clipSpeed(clip));
}

function clampFades<T extends Clip>(c: T): T {
  const half = Math.floor(c.durationUs / 2);
  if (c.fadeInUs + c.fadeOutUs > c.durationUs) {
    c.fadeInUs = Math.min(c.fadeInUs, half);
    c.fadeOutUs = Math.min(c.fadeOutUs, c.durationUs - c.fadeInUs);
  }
  return c;
}

// ---------------------------------------------------------------- clips

export function addClip(p0: Project, args: { trackId: string; clip: unknown }, ctx: CommandContext): Project {
  const p = clone(p0);
  const track = requireTrack(p, args.trackId);
  if (track.locked) throw new CommandError(`Track ${track.name} is locked`);
  const clip = ClipSchema.parse(args.clip);
  if (findClip(p, clip.id)) throw new CommandError(`Clip id ${clip.id} already exists`);
  if (track.kind === 'audio' && clip.kind !== 'audio') throw new CommandError('Only audio clips can go on audio tracks');
  if (track.kind === 'video' && clip.kind === 'audio') throw new CommandError('Audio clips must go on audio tracks');
  if (clip.kind !== 'text' && !ctx.assets[clip.assetId]) throw new CommandError(`Asset ${clip.assetId} not found`);
  const max = maxDurationUs(clip, ctx);
  if (clip.durationUs > max + 1) throw new CommandError('Clip duration exceeds available source media');
  track.clips.push(clip);
  return finalize(p);
}

/** Build a default clip for an asset (full source length; images/text default 5s). */
export function makeClipForAsset(asset: AssetIndex[string], timelineStartUs: number, project: Project): Clip {
  const base = { id: newId('c'), timelineStartUs: Math.max(0, Math.round(timelineStartUs)), assetId: asset.id, name: asset.name };
  if (asset.kind === 'image') {
    // Images smaller than the frame (logos, stickers) keep their native size; larger ones are fitted.
    const fitsNatively = !!asset.width && !!asset.height && asset.width <= project.settings.width && asset.height <= project.settings.height;
    return ClipSchema.parse({ ...base, kind: 'image', durationUs: 5_000_000, transform: { ...TransformSchema.parse({}), fit: fitsNatively ? 'none' : 'contain' } });
  }
  const dur = Math.max(MIN_DURATION_US, asset.durationUs ?? 5_000_000);
  if (asset.kind === 'audio') return ClipSchema.parse({ ...base, kind: 'audio', durationUs: dur });
  return ClipSchema.parse({ ...base, kind: 'video', durationUs: dur });
}

export function makeTextClip(args: {
  text: string;
  timelineStartUs: number;
  durationUs: number;
  y?: number;
  style?: Partial<TextClip['style']>;
  preset?: string | null;
  animation?: TextClip['animation'];
  x?: number;
}): TextClip {
  return ClipSchema.parse({
    id: newId('t'),
    kind: 'text',
    text: args.text,
    timelineStartUs: Math.round(args.timelineStartUs),
    durationUs: Math.round(args.durationUs),
    style: TextStyleSchema.parse(args.style ?? {}),
    transform: { ...TransformSchema.parse({}), x: args.x ?? 0, y: args.y ?? 0 },
    animation: args.animation ?? 'fade',
    preset: args.preset ?? null,
    fadeInUs: 0,
    fadeOutUs: 0,
  }) as TextClip;
}

export function removeClips(p0: Project, args: { clipIds: string[] }): Project {
  const p = clone(p0);
  for (const cid of args.clipIds) {
    const f = requireClip(p, cid);
    f.track.clips.splice(f.index, 1);
  }
  return finalize(p);
}

export function moveClip(
  p0: Project,
  args: { clipId: string; timelineStartUs: number; trackId?: string },
): Project {
  const p = clone(p0);
  const f = requireClip(p, args.clipId);
  const clip = f.clip;
  const target = args.trackId ? requireTrack(p, args.trackId) : f.track;
  if (target.locked) throw new CommandError(`Track ${target.name} is locked`);
  if (target.kind !== f.track.kind) throw new CommandError(`Cannot move a ${clip.kind} clip to a ${target.kind} track`);
  clip.timelineStartUs = Math.max(0, Math.round(args.timelineStartUs));
  if (target !== f.track) {
    f.track.clips.splice(f.index, 1);
    target.clips.push(clip);
  }
  return finalize(p);
}

/**
 * Trim a clip by setting new timeline bounds. Moving the start edge also shifts sourceStart so the
 * frames that remain visible stay at the same timeline positions. End edge is exclusive.
 */
export function trimClip(
  p0: Project,
  args: { clipId: string; startUs?: number; endUs?: number },
  ctx: CommandContext,
): Project {
  const p = clone(p0);
  const { clip } = requireClip(p, args.clipId);
  const speed = clipSpeed(clip);
  const oldStart = clip.timelineStartUs;
  const oldEnd = clipEndUs(clip);
  let newStart = args.startUs !== undefined ? Math.round(args.startUs) : oldStart;
  let newEnd = args.endUs !== undefined ? Math.round(args.endUs) : oldEnd;

  if (clip.kind === 'video' || clip.kind === 'audio') {
    // Start edge cannot go before source time 0. (Images are stills: no source-time limit.)
    const earliest = oldStart - Math.floor(clip.sourceStartUs / speed);
    newStart = Math.max(newStart, earliest, 0);
  } else {
    newStart = Math.max(newStart, 0);
  }
  if (newEnd - newStart < MIN_DURATION_US) {
    if (args.startUs !== undefined) newStart = newEnd - MIN_DURATION_US;
    else newEnd = newStart + MIN_DURATION_US;
  }
  if (clip.kind !== 'text') {
    clip.sourceStartUs = Math.max(0, Math.round(clip.sourceStartUs + (newStart - oldStart) * speed));
  }
  if ('keyframes' in clip && clip.keyframes.length && newStart !== oldStart) {
    // Keyframes are clip-relative: keep them at the same timeline positions.
    const shift = newStart - oldStart;
    const keys = clip.keyframes;
    const atStart = keyframeValuesAt(keys, shift)!;
    const moved = keys.map((k) => ({ ...k, tUs: k.tUs - shift })).filter((k) => k.tUs > 0);
    clip.keyframes = [{ tUs: 0, ...atStart }, ...moved].slice(0, 100);
  }
  clip.timelineStartUs = newStart;
  clip.durationUs = newEnd - newStart;
  const max = maxDurationUs(clip, ctx);
  if (clip.durationUs > max) clip.durationUs = Math.max(MIN_DURATION_US, max);
  clampFades(clip);
  return finalize(p);
}

/** Split at a timeline time strictly inside the clip. Right half gets a new id. */
export function splitClip(p0: Project, args: { clipId: string; atUs: number; newId?: string }): Project {
  const p = clone(p0);
  const { track, clip } = requireClip(p, args.clipId);
  const at = Math.round(args.atUs);
  if (at - clip.timelineStartUs < MIN_DURATION_US || clipEndUs(clip) - at < MIN_DURATION_US)
    throw new CommandError('Split point must be inside the clip (at least one frame from either edge)');
  const right = clone(clip) as Clip;
  right.id = args.newId ?? newId('c');
  const leftDur = at - clip.timelineStartUs;
  right.timelineStartUs = at;
  right.durationUs = clip.durationUs - leftDur;
  if (right.kind !== 'text' && clip.kind !== 'text') {
    right.sourceStartUs = Math.round(clip.sourceStartUs + leftDur * clipSpeed(clip));
  }
  if ('transitionIn' in right) right.transitionIn = null;
  if ('gainPoints' in right && 'gainPoints' in clip) {
    // Insert an interpolated point at the cut on each side so the automation envelope is unchanged.
    // Each side gains at most one point while losing at least one, so the 64-point cap still holds.
    const pts = clip.gainPoints;
    const atCut = interpGain(pts, leftDur);
    right.gainPoints = pts.filter((g) => g.tUs >= leftDur).map((g) => ({ ...g, tUs: g.tUs - leftDur }));
    if (pts.some((g) => g.tUs < leftDur) && !right.gainPoints.some((g) => g.tUs === 0)) right.gainPoints.unshift({ tUs: 0, gain: atCut });
    clip.gainPoints = pts.filter((g) => g.tUs < leftDur);
    if (pts.some((g) => g.tUs >= leftDur)) clip.gainPoints.push({ tUs: leftDur, gain: atCut });
  }
  if ('keyframes' in right && 'keyframes' in clip && clip.keyframes.length) {
    // Split keyframes; add an interpolated key at the cut on both sides so motion is unchanged.
    const keys = clip.keyframes;
    const atCut = keyframeValuesAt(keys, leftDur)!;
    right.keyframes = [{ tUs: 0, ...atCut }, ...keys.filter((k) => k.tUs > leftDur).map((k) => ({ ...k, tUs: k.tUs - leftDur }))];
    clip.keyframes = [...keys.filter((k) => k.tUs < leftDur), { tUs: leftDur, ...atCut }];
  }
  right.fadeInUs = 0;
  clip.durationUs = leftDur;
  clip.fadeOutUs = 0;
  clampFades(clip);
  clampFades(right);
  track.clips.push(right);
  return finalize(p);
}

/** Generic property update; the merged clip is re-validated by schema. kind/id/assetId cannot change. */
export function updateClip(p0: Project, args: { clipId: string; patch: Record<string, unknown> }, ctx: CommandContext): Project {
  const p = clone(p0);
  const { track, index, clip } = requireClip(p, args.clipId);
  const patch = { ...args.patch };
  delete patch.id;
  delete patch.kind;
  delete patch.assetId;
  const merged: Record<string, unknown> = { ...clip, ...patch };
  for (const key of ['transform', 'adjust', 'style'] as const) {
    if (patch[key] && typeof patch[key] === 'object' && key in clip) {
      merged[key] = { ...(clip as Record<string, unknown>)[key] as object, ...(patch[key] as object) };
      if (key === 'transform' && (patch.transform as { crop?: object }).crop) {
        (merged.transform as Record<string, unknown>).crop = {
          ...(clip as { transform: { crop: object } }).transform.crop,
          ...(patch.transform as { crop: object }).crop,
        };
      }
    }
  }
  const parsed = ClipSchema.safeParse(merged);
  if (!parsed.success) throw new CommandError('Invalid clip properties: ' + parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const next = parsed.data;
  // Speed change keeps source range length bounded by media.
  const max = maxDurationUs(next, ctx);
  if (next.durationUs > max) next.durationUs = Math.max(MIN_DURATION_US, max);
  clampFades(next);
  track.clips[index] = next;
  return finalize(p);
}

export function duplicateClip(p0: Project, args: { clipId: string; newId?: string; atUs?: number }): Project {
  const p = clone(p0);
  const { track, clip } = requireClip(p, args.clipId);
  const copy = clone(clip);
  copy.id = args.newId ?? newId('c');
  copy.timelineStartUs = args.atUs ?? clipEndUs(clip);
  track.clips.push(copy);
  return finalize(p);
}

/** Paste clips (from clipboard) at a time, preserving relative offsets. */
export function pasteClips(p0: Project, args: { clips: { trackId: string; clip: Clip }[]; atUs: number }, ctx: CommandContext): Project {
  if (args.clips.length === 0) return p0;
  const minStart = Math.min(...args.clips.map((c) => c.clip.timelineStartUs));
  let p = p0;
  for (const item of args.clips) {
    const clip = { ...clone(item.clip), id: newId(item.clip.kind === 'text' ? 't' : 'c') };
    clip.timelineStartUs = Math.round(args.atUs + (item.clip.timelineStartUs - minStart));
    const trackId = p.tracks.some((t) => t.id === item.trackId) ? item.trackId : p.tracks.find((t) => t.kind === (clip.kind === 'audio' ? 'audio' : 'video'))!.id;
    p = addClip(p, { trackId, clip }, ctx);
  }
  return p;
}

export function setTransition(p0: Project, args: { clipId: string; transition: Transition | null }): Project {
  const p = clone(p0);
  const { clip } = requireClip(p, args.clipId);
  if (clip.kind !== 'video' && clip.kind !== 'image') throw new CommandError('Transitions apply to video or image clips');
  clip.transitionIn = args.transition;
  return finalize(p);
}

/** Ripple delete: remove clip and shift later clips on the same track left by its duration. */
export function rippleDelete(p0: Project, args: { clipId: string }): Project {
  const p = clone(p0);
  const { track, index, clip } = requireClip(p, args.clipId);
  track.clips.splice(index, 1);
  const end = clipEndUs(clip);
  for (const c of track.clips) if (c.timelineStartUs >= end) c.timelineStartUs -= clip.durationUs;
  return finalize(p);
}

// ---------------------------------------------------------------- tracks

export function addTrack(p0: Project, args: { kind: 'video' | 'audio'; id?: string }): Project {
  const p = clone(p0);
  const same = p.tracks.filter((t) => t.kind === args.kind);
  const name = `${args.kind === 'video' ? 'V' : 'A'}${same.length + 1}`;
  const track: Track = { id: args.id ?? newId('trk'), kind: args.kind, name, muted: false, hidden: false, locked: false, volume: 1, clips: [] };
  if (args.kind === 'video') p.tracks.unshift(track);
  else p.tracks.push(track);
  return finalize(p);
}

export function removeTrack(p0: Project, args: { trackId: string }): Project {
  const p = clone(p0);
  const t = requireTrack(p, args.trackId);
  if (t.locked) throw new CommandError('Track is locked');
  if (p.tracks.filter((x) => x.kind === t.kind).length <= 1) throw new CommandError(`Project needs at least one ${t.kind} track`);
  p.tracks = p.tracks.filter((x) => x.id !== t.id);
  return finalize(p);
}

export function updateTrack(p0: Project, args: { trackId: string; patch: Partial<Pick<Track, 'muted' | 'hidden' | 'locked' | 'volume' | 'name'>> }): Project {
  const p = clone(p0);
  const t = requireTrack(p, args.trackId);
  Object.assign(t, args.patch);
  return finalize(p);
}

/** Move a track up/down within its kind group (changes layer order for visual tracks). */
export function reorderTrack(p0: Project, args: { trackId: string; direction: -1 | 1 }): Project {
  const p = clone(p0);
  const i = p.tracks.findIndex((t) => t.id === args.trackId);
  if (i < 0) throw new CommandError('Track not found');
  const j = i + args.direction;
  if (j < 0 || j >= p.tracks.length || p.tracks[j].kind !== p.tracks[i].kind) return p0;
  [p.tracks[i], p.tracks[j]] = [p.tracks[j], p.tracks[i]];
  return finalize(p);
}

// ---------------------------------------------------------------- project settings / captions

export function updateSettings(p0: Project, args: { patch: Partial<Settings>; aspect?: AspectPreset }): Project {
  const p = clone(p0);
  Object.assign(p.settings, args.patch);
  if (args.aspect) Object.assign(p.settings, ASPECT_PRESETS[args.aspect]);
  return finalize(p);
}

export function renameProject(p0: Project, args: { name: string }): Project {
  const p = clone(p0);
  p.name = args.name.trim().slice(0, 120) || 'Untitled';
  return finalize(p);
}

export function setCaptions(p0: Project, args: { segments: CaptionSegment[]; sourceAssetId?: string | null; language?: string | null }): Project {
  const p = clone(p0);
  p.captions.segments = args.segments.map((s) => ({ ...s, startUs: Math.round(s.startUs), endUs: Math.round(s.endUs) })).sort((a, b) => a.startUs - b.startUs);
  if (args.sourceAssetId !== undefined) p.captions.sourceAssetId = args.sourceAssetId;
  if (args.language !== undefined) p.captions.language = args.language;
  return finalize(p);
}

export function updateCaption(p0: Project, args: { id: string; patch: Partial<Omit<CaptionSegment, 'id'>> }): Project {
  const p = clone(p0);
  const s = p.captions.segments.find((x) => x.id === args.id);
  if (!s) throw new CommandError('Caption not found');
  Object.assign(s, args.patch);
  if (s.endUs <= s.startUs) throw new CommandError('Caption end must be after start');
  p.captions.segments.sort((a, b) => a.startUs - b.startUs);
  return finalize(p);
}

export function removeCaption(p0: Project, args: { id: string }): Project {
  const p = clone(p0);
  p.captions.segments = p.captions.segments.filter((s) => s.id !== args.id);
  return finalize(p);
}

export function addCaption(p0: Project, args: { startUs: number; endUs: number; text: string }): Project {
  const p = clone(p0);
  p.captions.segments.push({ id: newId('cap'), startUs: Math.round(args.startUs), endUs: Math.round(args.endUs), text: args.text });
  p.captions.segments.sort((a, b) => a.startUs - b.startUs);
  return finalize(p);
}

export function updateCaptionSettings(p0: Project, args: { patch: Record<string, unknown> }): Project {
  const p = clone(p0);
  const merged = { ...p.captions, ...args.patch, style: { ...p.captions.style, ...((args.patch.style as object) ?? {}) } };
  const r = CaptionsSchema.safeParse(merged);
  if (!r.success) throw new CommandError('Invalid caption settings');
  p.captions = r.data;
  return finalize(p);
}

/** Apply volume ducking: adds gain points to a clip that dip under caption segments (speech). */
export function duckUnderCaptions(p0: Project, args: { clipId: string; duckGain: number; rampUs?: number; ranges?: { startUs: number; endUs: number }[] }): Project {
  const p = clone(p0);
  const { clip } = requireClip(p, args.clipId);
  if (clip.kind !== 'audio' && clip.kind !== 'video') throw new CommandError('Ducking applies to audio-bearing clips');
  const ramp = args.rampUs ?? 250_000;
  const points: { tUs: number; gain: number }[] = [];
  const start = clip.timelineStartUs;
  const end = clipEndUs(clip);
  // Merge caption segments that are close together.
  const segs = [...(args.ranges ?? p.captions.segments)].sort((a, b) => a.startUs - b.startUs);
  const merged: { s: number; e: number }[] = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && s.startUs - last.e < 2 * ramp) last.e = Math.max(last.e, s.endUs);
    else merged.push({ s: s.startUs, e: s.endUs });
  }
  for (const m of merged) {
    if (m.e <= start || m.s >= end) continue;
    const add = (t: number, g: number) => {
      const rel = Math.round(t - start);
      if (rel >= 0 && rel <= clip.durationUs) points.push({ tUs: rel, gain: g });
    };
    add(m.s - ramp, 1);
    add(m.s, args.duckGain);
    add(m.e, args.duckGain);
    add(m.e + ramp, 1);
  }
  points.sort((a, b) => a.tUs - b.tUs);
  clip.gainPoints = points.slice(0, 64);
  return finalize(p);
}

/**
 * Cut timeline ranges out of one clip (e.g. detected silences) and ripple the rest of that track
 * left so no gaps remain. Captions inside removed ranges are deleted; later captions shift left.
 * Ranges are timeline µs, half-open, and are clamped to the clip. Other tracks are not moved.
 */
export function removeRangesFromClip(p0: Project, args: { clipId: string; ranges: { startUs: number; endUs: number }[] }): Project {
  const f0 = requireClip(p0, args.clipId);
  const clipStart = f0.clip.timelineStartUs;
  const clipEnd = clipEndUs(f0.clip);
  const ranges = args.ranges
    .map((r) => ({ startUs: Math.max(clipStart, Math.round(r.startUs)), endUs: Math.min(clipEnd, Math.round(r.endUs)) }))
    .filter((r) => r.endUs - r.startUs >= MIN_DURATION_US)
    .sort((a, b) => b.startUs - a.startUs); // process from the end so earlier positions stay valid
  if (ranges.length === 0) return p0;
  let p = p0;
  const trackId = f0.track.id;
  for (const r of ranges) {
    // Find the piece of the (possibly already split) clip that contains this range.
    const track = p.tracks.find((t) => t.id === trackId)!;
    const piece = track.clips.find((c) => c.timelineStartUs <= r.startUs && clipEndUs(c) >= r.endUs && (c.id === args.clipId || c.id.startsWith(args.clipId + '_')));
    if (!piece) continue;
    let target = piece.id;
    if (r.startUs - piece.timelineStartUs >= MIN_DURATION_US) {
      const rightId = `${args.clipId}_${Math.random().toString(36).slice(2, 8)}`;
      p = splitClip(p, { clipId: target, atUs: r.startUs, newId: rightId });
      target = rightId;
    }
    const tgt = findClip(p, target)!.clip;
    if (clipEndUs(tgt) - r.endUs >= MIN_DURATION_US) p = splitClip(p, { clipId: target, atUs: r.endUs, newId: `${args.clipId}_${Math.random().toString(36).slice(2, 8)}` });
    p = rippleDelete(p, { clipId: target });
    // Captions: drop those fully inside, shift later ones, trim overlapping ones.
    const len = r.endUs - r.startUs;
    const q = clone(p);
    q.captions.segments = q.captions.segments
      .filter((s) => !(s.startUs >= r.startUs && s.endUs <= r.endUs))
      .map((s) => {
        if (s.startUs >= r.endUs) return { ...s, startUs: s.startUs - len, endUs: s.endUs - len };
        if (s.endUs > r.startUs && s.startUs < r.startUs) return { ...s, endUs: Math.max(s.startUs + MIN_DURATION_US, s.endUs > r.endUs ? s.endUs - len : r.startUs) };
        if (s.startUs < r.endUs && s.endUs > r.endUs) return { ...s, startUs: r.startUs, endUs: s.endUs - len };
        return s;
      });
    p = finalize(q);
  }
  return p;
}

/**
 * AI-10: reframe a project for a social aspect ratio. Media clips switch to "cover" (fill frame,
 * centered; editable afterwards via X/Y or drag), text positions and sizes scale to the new frame.
 */
export function reframeForAspect(p0: Project, args: { aspect: AspectPreset; name?: string }): Project {
  const p = clone(p0);
  const oldW = p.settings.width;
  const oldH = p.settings.height;
  const { width: W, height: H } = ASPECT_PRESETS[args.aspect];
  const sx = W / oldW;
  const sy = H / oldH;
  const sText = Math.min(sx, sy);
  p.settings.width = W;
  p.settings.height = H;
  if (args.name) p.name = args.name.slice(0, 120);
  for (const t of p.tracks) {
    for (const c of t.clips) {
      if (c.kind === 'video' || c.kind === 'image') {
        const fullFrame = c.transform.scale === 1 && c.transform.x === 0 && c.transform.y === 0;
        if (fullFrame) c.transform = { ...c.transform, fit: 'cover' };
        else c.transform = { ...c.transform, x: Math.round(c.transform.x * sx), y: Math.round(c.transform.y * sy) };
      } else if (c.kind === 'text') {
        c.transform = { ...c.transform, x: Math.round(c.transform.x * sx), y: Math.round(c.transform.y * sy) };
        c.style = { ...c.style, fontSize: Math.max(8, Math.round(c.style.fontSize * sText)), strokeWidth: Math.round(c.style.strokeWidth * sText) };
      }
    }
  }
  p.captions.style.fontSize = Math.max(12, Math.round(p.captions.style.fontSize * Math.max(sText, 0.75)));
  return finalize(p);
}

/**
 * FX-07 "auto-key": set transform values for a visual clip at a clip-local time. Without keyframes
 * this edits the base transform; once a clip is animated it upserts a keyframe at that time.
 */
export function setTransformAt(p0: Project, args: { clipId: string; localUs: number; patch: Partial<Pick<Transform, 'x' | 'y' | 'scale' | 'rotation' | 'opacity'>> & Record<string, unknown>; forceKeyframe?: boolean; toleranceUs?: number }): Project {
  const p = clone(p0);
  const { clip } = requireClip(p, args.clipId);
  if (clip.kind === 'audio') throw new CommandError('Audio clips have no transform');
  const animated = clip.keyframes.length > 0 || args.forceKeyframe;
  if (!animated) {
    const merged = TransformSchema.safeParse({ ...clip.transform, ...args.patch });
    if (!merged.success) throw new CommandError('Invalid transform values');
    clip.transform = merged.data;
    return finalize(p);
  }
  const t = Math.max(0, Math.min(clip.durationUs, Math.round(args.localUs)));
  const cur = effectiveTransform(clip, t);
  const key = { tUs: t, x: cur.x, y: cur.y, scale: cur.scale, rotation: cur.rotation, opacity: cur.opacity };
  for (const k of ['x', 'y', 'scale', 'rotation', 'opacity'] as const) if (typeof args.patch[k] === 'number') key[k] = args.patch[k] as number;
  const tol = args.toleranceUs ?? 20_000;
  // Non-animated properties (fit/crop) still go to the base transform.
  const rest = Object.fromEntries(Object.entries(args.patch).filter(([k]) => !['x', 'y', 'scale', 'rotation', 'opacity'].includes(k)));
  if (Object.keys(rest).length) clip.transform = TransformSchema.parse({ ...clip.transform, ...rest });
  clip.keyframes = [...clip.keyframes.filter((k) => Math.abs(k.tUs - t) > tol), key].sort((a, b) => a.tUs - b.tUs).slice(0, 100);
  return finalize(p);
}

export function removeKeyframe(p0: Project, args: { clipId: string; tUs: number }): Project {
  const p = clone(p0);
  const { clip } = requireClip(p, args.clipId);
  if (clip.kind === 'audio') return p0;
  const keys = clip.keyframes;
  if (keys.length === 1) {
    // Removing the last key bakes its values into the base transform (no jump).
    const k = keys[0];
    clip.transform = { ...clip.transform, x: k.x, y: k.y, scale: k.scale, rotation: k.rotation, opacity: k.opacity };
  }
  clip.keyframes = keys.filter((k) => k.tUs !== args.tUs);
  return finalize(p);
}

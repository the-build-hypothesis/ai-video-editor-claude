/**
 * Canonical project model (schema version 2).
 *
 * TIMEBASE: every time value is an integer number of MICROSECONDS (µs).
 *  - Clip occupies the half-open interval [timelineStartUs, timelineStartUs + durationUs).
 *  - Source mapping: sourceTimeUs(t) = sourceStartUs + (t - timelineStartUs) * speed.
 *    The clip consumes source range [sourceStartUs, sourceStartUs + durationUs * speed).
 *  - Export frame n (0-based) is sampled at t = round(n * 1e6 / fps).
 *  - All edit commands round results to integers; UI positions are snapped to frame
 *    boundaries (see time.ts) so repeated edits do not accumulate floating-point drift.
 *
 * This module is UI-independent and shared by the browser (preview/export) and the Worker
 * (validation on read/write).
 */
import { z } from 'zod';

export const SCHEMA_VERSION = 2;
export const US = 1_000_000;
export const MAX_PROJECT_DURATION_US = 30 * 60 * US;

const us = z.number().int().min(0).max(MAX_PROJECT_DURATION_US * 4);
const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
/** Colors are restricted to hex so user text can never inject CSS/HTML. */
export const ColorSchema = z.string().regex(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);

export const TransformSchema = z.object({
  /** Offset of clip center from frame center, in project pixels. */
  x: z.number().min(-10000).max(10000).default(0),
  y: z.number().min(-10000).max(10000).default(0),
  /** Multiplier applied after fitting. */
  scale: z.number().min(0.01).max(20).default(1),
  rotation: z.number().min(-360).max(360).default(0),
  opacity: z.number().min(0).max(1).default(1),
  /** How the source is fitted into the frame before scale is applied. */
  fit: z.enum(['contain', 'cover', 'stretch', 'none']).default('contain'),
  /** Fractional crop of the source on each edge (0..0.95). */
  crop: z
    .object({
      left: z.number().min(0).max(0.95).default(0),
      top: z.number().min(0).max(0.95).default(0),
      right: z.number().min(0).max(0.95).default(0),
      bottom: z.number().min(0).max(0.95).default(0),
    })
    .default({ left: 0, top: 0, right: 0, bottom: 0 }),
});
export type Transform = z.infer<typeof TransformSchema>;

export const AdjustSchema = z.object({
  brightness: z.number().min(-1).max(1).default(0),
  contrast: z.number().min(-1).max(1).default(0),
  saturation: z.number().min(-1).max(1).default(0),
});
export type Adjust = z.infer<typeof AdjustSchema>;

export const TRANSITION_TYPES = ['dissolve', 'wipeleft', 'wiperight', 'fadeblack'] as const;
export const TransitionSchema = z.object({
  type: z.enum(TRANSITION_TYPES),
  /** Centered on the cut: covers [cut - d/2, cut + d/2). */
  durationUs: z.number().int().min(33_000).max(5 * US),
});
export type Transition = z.infer<typeof TransitionSchema>;

/** Gain automation point, time relative to clip start. */
export const GainPointSchema = z.object({ tUs: us, gain: z.number().min(0).max(4) });

const clipBase = {
  id,
  timelineStartUs: us,
  durationUs: z.number().int().min(1000).max(MAX_PROJECT_DURATION_US),
  fadeInUs: us.default(0),
  fadeOutUs: us.default(0),
};

const mediaBase = {
  ...clipBase,
  assetId: id,
  sourceStartUs: us.default(0),
  name: z.string().max(200).default(''),
};

export const VideoClipSchema = z.object({
  ...mediaBase,
  kind: z.literal('video'),
  speed: z.number().min(0.25).max(4).default(1),
  volume: z.number().min(0).max(4).default(1),
  muted: z.boolean().default(false),
  transform: TransformSchema.default(TransformSchema.parse({})),
  adjust: AdjustSchema.default({ brightness: 0, contrast: 0, saturation: 0 }),
  transitionIn: TransitionSchema.nullable().default(null),
  gainPoints: z.array(GainPointSchema).max(64).default([]),
});
export const ImageClipSchema = z.object({
  ...mediaBase,
  kind: z.literal('image'),
  transform: TransformSchema.default(TransformSchema.parse({})),
  adjust: AdjustSchema.default({ brightness: 0, contrast: 0, saturation: 0 }),
  transitionIn: TransitionSchema.nullable().default(null),
});
export const AudioClipSchema = z.object({
  ...mediaBase,
  kind: z.literal('audio'),
  speed: z.number().min(0.25).max(4).default(1),
  volume: z.number().min(0).max(4).default(1),
  muted: z.boolean().default(false),
  gainPoints: z.array(GainPointSchema).max(64).default([]),
});

export const TextStyleSchema = z.object({
  fontFamily: z.enum(['Inter', 'Georgia', 'Courier New', 'Impact', 'Arial']).default('Inter'),
  fontSize: z.number().min(8).max(400).default(72),
  color: ColorSchema.default('#ffffff'),
  /** Optional box behind text. */
  background: ColorSchema.nullable().default(null),
  bold: z.boolean().default(true),
  italic: z.boolean().default(false),
  align: z.enum(['left', 'center', 'right']).default('center'),
  strokeColor: ColorSchema.nullable().default('#000000'),
  strokeWidth: z.number().min(0).max(40).default(0),
  shadow: z.boolean().default(true),
});
export type TextStyle = z.infer<typeof TextStyleSchema>;

export const TEXT_ANIMATIONS = ['none', 'fade', 'slideUp', 'pop', 'typewriter'] as const;
export const TextClipSchema = z.object({
  ...clipBase,
  kind: z.literal('text'),
  text: z.string().max(2000),
  style: TextStyleSchema.default(TextStyleSchema.parse({})),
  /** Position offset from frame center in project pixels (x, y), plus scale/opacity. */
  transform: TransformSchema.default(TransformSchema.parse({})),
  animation: z.enum(TEXT_ANIMATIONS).default('none'),
  /** Optional preset tag (e.g. lower third) used by UI only. */
  preset: z.string().max(40).nullable().default(null),
});

export const ClipSchema = z.discriminatedUnion('kind', [VideoClipSchema, ImageClipSchema, AudioClipSchema, TextClipSchema]);
export type VideoClip = z.infer<typeof VideoClipSchema>;
export type ImageClip = z.infer<typeof ImageClipSchema>;
export type AudioClip = z.infer<typeof AudioClipSchema>;
export type TextClip = z.infer<typeof TextClipSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export type MediaClip = VideoClip | ImageClip | AudioClip;
export type VisualClip = VideoClip | ImageClip | TextClip;

export const TrackSchema = z.object({
  id,
  /** 'video' tracks hold visual clips (video, image, text); 'audio' tracks hold audio clips. */
  kind: z.enum(['video', 'audio']),
  name: z.string().max(60),
  muted: z.boolean().default(false),
  hidden: z.boolean().default(false),
  locked: z.boolean().default(false),
  volume: z.number().min(0).max(4).default(1),
  clips: z.array(ClipSchema).max(2000),
});
export type Track = z.infer<typeof TrackSchema>;

export const CaptionSegmentSchema = z.object({
  id,
  startUs: us,
  endUs: us,
  text: z.string().max(500),
});
export type CaptionSegment = z.infer<typeof CaptionSegmentSchema>;

export const CaptionStyleSchema = z.object({
  fontSize: z.number().min(12).max(200).default(54),
  color: ColorSchema.default('#ffffff'),
  background: ColorSchema.nullable().default('#000000b3'),
  position: z.enum(['bottom', 'top', 'middle']).default('bottom'),
  /** Margin from the edge as a fraction of frame height. */
  margin: z.number().min(0).max(0.45).default(0.07),
  bold: z.boolean().default(true),
});

export const CaptionsSchema = z.object({
  /** Shown in preview. */
  enabled: z.boolean().default(true),
  /** Burned into export (AI-03). */
  burnIn: z.boolean().default(true),
  style: CaptionStyleSchema.default(CaptionStyleSchema.parse({})),
  segments: z.array(CaptionSegmentSchema).max(5000).default([]),
  /** Asset and language the captions were generated from (informational). */
  sourceAssetId: id.nullable().default(null),
  language: z.string().max(20).nullable().default(null),
});
export type Captions = z.infer<typeof CaptionsSchema>;

export const ASPECT_PRESETS = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
} as const;
export type AspectPreset = keyof typeof ASPECT_PRESETS;

export const SettingsSchema = z.object({
  width: z.number().int().min(16).max(3840).refine((v) => v % 2 === 0, 'width must be even'),
  height: z.number().int().min(16).max(3840).refine((v) => v % 2 === 0, 'height must be even'),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]),
  backgroundColor: ColorSchema.default('#000000'),
  /** Master output gain (linear). Final mix also passes a limiter (see audio policy). */
  masterVolume: z.number().min(0).max(2).default(1),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const ProjectSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id,
    name: z.string().min(1).max(120),
    settings: SettingsSchema,
    tracks: z.array(TrackSchema).min(1).max(16),
    captions: CaptionsSchema.default(CaptionsSchema.parse({})),
  })
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    for (const t of p.tracks) {
      if (seen.has(t.id)) ctx.addIssue({ code: 'custom', message: `duplicate id ${t.id}` });
      seen.add(t.id);
      for (const c of t.clips) {
        if (seen.has(c.id)) ctx.addIssue({ code: 'custom', message: `duplicate id ${c.id}` });
        seen.add(c.id);
        const okKind = t.kind === 'audio' ? c.kind === 'audio' : c.kind !== 'audio';
        if (!okKind) ctx.addIssue({ code: 'custom', message: `clip ${c.id} (${c.kind}) not allowed on ${t.kind} track` });
        if (c.fadeInUs + c.fadeOutUs > c.durationUs)
          ctx.addIssue({ code: 'custom', message: `clip ${c.id} fades exceed duration` });
      }
    }
    for (const s of p.captions.segments) {
      if (s.endUs <= s.startUs) ctx.addIssue({ code: 'custom', message: `caption ${s.id} has end <= start` });
    }
  });
export type Project = z.infer<typeof ProjectSchema>;

/** Minimal asset info needed by commands/rendering (subset of server asset record). */
export interface AssetInfo {
  id: string;
  name: string;
  kind: 'video' | 'image' | 'audio';
  durationUs: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
}
export type AssetIndex = Record<string, AssetInfo>;

export function newId(prefix = ''): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  const s = Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
  return prefix ? `${prefix}_${s}` : s;
}

export function createEmptyProject(opts: { id: string; name: string; aspect?: AspectPreset; fps?: Settings['fps'] }): Project {
  const dims = ASPECT_PRESETS[opts.aspect ?? '16:9'];
  return ProjectSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: opts.id,
    name: opts.name,
    settings: { ...dims, fps: opts.fps ?? 30, backgroundColor: '#000000', masterVolume: 1 },
    // Display order top→bottom. Visual tracks earlier in the array composite ON TOP.
    tracks: [
      { id: 'v2', kind: 'video', name: 'V2', clips: [] },
      { id: 'v1', kind: 'video', name: 'V1', clips: [] },
      { id: 'a1', kind: 'audio', name: 'A1', clips: [] },
      { id: 'a2', kind: 'audio', name: 'A2', clips: [] },
    ],
    captions: {},
  });
}

export function clipEndUs(c: { timelineStartUs: number; durationUs: number }): number {
  return c.timelineStartUs + c.durationUs;
}

export function clipSpeed(c: Clip): number {
  return c.kind === 'video' || c.kind === 'audio' ? c.speed : 1;
}

export function projectDurationUs(p: Project): number {
  let end = 0;
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, clipEndUs(c));
  return end;
}

export function findClip(p: Project, clipId: string): { track: Track; clip: Clip; index: number } | null {
  for (const track of p.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index], index };
  }
  return null;
}

/** Shared fixtures for unit tests of src/shared. */
import { createEmptyProject, ProjectSchema, type AssetIndex, type Project, type Clip } from '../../src/shared/model';
import type { CommandContext } from '../../src/shared/commands';

export const S = 1_000_000;

export const assets: AssetIndex = {
  vid10: { id: 'vid10', name: 'Interview.mp4', kind: 'video', durationUs: 10 * S, width: 1920, height: 1080, hasAudio: true },
  vid5silent: { id: 'vid5silent', name: 'Broll.mp4', kind: 'video', durationUs: 5 * S, width: 1920, height: 1080, hasAudio: false },
  music: { id: 'music', name: 'Music.mp3', kind: 'audio', durationUs: 60 * S, width: null, height: null, hasAudio: true },
  img: { id: 'img', name: 'Logo.png', kind: 'image', durationUs: null, width: 512, height: 512, hasAudio: false },
};

export const ctx: CommandContext = { assets };

/** Empty project: tracks v2 (top), v1, a1, a2. */
export function emptyProject(fps: 24 | 25 | 30 | 50 | 60 = 30): Project {
  return createEmptyProject({ id: 'p1', name: 'Test', fps });
}

export function videoClip(id: string, start: number, dur: number, extra: Record<string, unknown> = {}) {
  return { id, kind: 'video', assetId: 'vid10', timelineStartUs: start, durationUs: dur, ...extra };
}
export function audioClip(id: string, start: number, dur: number, extra: Record<string, unknown> = {}) {
  return { id, kind: 'audio', assetId: 'music', timelineStartUs: start, durationUs: dur, ...extra };
}
export function imageClip(id: string, start: number, dur: number, extra: Record<string, unknown> = {}) {
  return { id, kind: 'image', assetId: 'img', timelineStartUs: start, durationUs: dur, ...extra };
}
export function textClip(id: string, start: number, dur: number, extra: Record<string, unknown> = {}) {
  return { id, kind: 'text', text: 'Hello', timelineStartUs: start, durationUs: dur, ...extra };
}

/** Build a validated project by placing raw clip objects on tracks (bypasses commands). */
export function projectWith(clips: Record<string, Record<string, unknown>[]>, mutate?: (p: Project) => void): Project {
  const p = emptyProject();
  for (const [trackId, list] of Object.entries(clips)) {
    const t = p.tracks.find((x) => x.id === trackId);
    if (!t) throw new Error(`no track ${trackId}`);
    t.clips.push(...(list as unknown as Clip[]));
  }
  mutate?.(p);
  return ProjectSchema.parse(p);
}

export function getClip(p: Project, id: string): Clip {
  for (const t of p.tracks) for (const c of t.clips) if (c.id === id) return c;
  throw new Error(`clip ${id} not found`);
}

export function trackOf(p: Project, clipId: string): string {
  for (const t of p.tracks) if (t.clips.some((c) => c.id === clipId)) return t.id;
  throw new Error(`clip ${clipId} not found`);
}

export function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

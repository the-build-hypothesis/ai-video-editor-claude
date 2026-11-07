import { describe, it, expect } from 'vitest';
import {
  evaluateVisualLayers,
  sourceTimeAt,
  activeCaption,
  audioSegments,
  segmentGainAt,
  interpGain,
  exportPlan,
  fadeFactor,
  findTransitionPredecessor,
  textAnimation,
  type AudioSegment,
} from '../../src/shared/timeline-eval';
import { frameToUs } from '../../src/shared/time';
import * as cmd from '../../src/shared/commands';
import type { TextClip } from '../../src/shared/model';
import { S, assets, videoClip, audioClip, imageClip, textClip, projectWith, getClip } from './helpers';

const ids = (layers: { clip: { id: string } }[]) => layers.map((l) => l.clip.id);

describe('evaluateVisualLayers ordering', () => {
  const p = projectWith({
    v2: [textClip('title', S, 4 * S)],
    v1: [videoClip('base', 0, 5 * S), imageClip('overlay', 2 * S, S)],
    a1: [audioClip('music', 0, 5 * S)],
  });

  it('returns layers bottom→top: later tracks below, earlier tracks on top; later start on top within a track', () => {
    expect(ids(evaluateVisualLayers(p, 2.5 * S))).toEqual(['base', 'overlay', 'title']);
    expect(ids(evaluateVisualLayers(p, 0.5 * S))).toEqual(['base']);
    expect(ids(evaluateVisualLayers(p, 4 * S))).toEqual(['base', 'title']);
  });

  it('reordering tracks changes layer order', () => {
    const q = cmd.reorderTrack(p, { trackId: 'v1', direction: -1 });
    expect(ids(evaluateVisualLayers(q, 2.5 * S))).toEqual(['title', 'base', 'overlay']);
  });

  it('skips hidden tracks and never includes audio clips', () => {
    const q = cmd.updateTrack(p, { trackId: 'v2', patch: { hidden: true } });
    expect(ids(evaluateVisualLayers(q, 2.5 * S))).toEqual(['base', 'overlay']);
    for (const l of evaluateVisualLayers(p, 2.5 * S)) expect(l.clip.kind).not.toBe('audio');
  });

  it('uses half-open clip intervals [start, end)', () => {
    expect(ids(evaluateVisualLayers(p, 3 * S - 1))).toContain('overlay');
    expect(ids(evaluateVisualLayers(p, 3 * S))).not.toContain('overlay');
    expect(ids(evaluateVisualLayers(p, 5 * S))).toEqual([]);
  });

  it('reports local and source times', () => {
    const q = projectWith({ v1: [videoClip('v', 2 * S, 4 * S, { sourceStartUs: S, speed: 2 })] });
    const [l] = evaluateVisualLayers(q, 3 * S);
    expect(l.localUs).toBe(S);
    expect(l.sourceUs).toBe(3 * S);
    expect(l.wipe).toBeNull();
  });
});

describe('fades', () => {
  const p = projectWith({ v1: [videoClip('v', 0, 4 * S, { fadeInUs: S, fadeOutUs: 2 * S })] });
  const op = (t: number) => evaluateVisualLayers(p, t)[0]?.opacity ?? 0;

  it('ramps opacity linearly in and out', () => {
    expect(op(0)).toBe(0);
    expect(evaluateVisualLayers(p, 0)).toHaveLength(0); // fully transparent layers are dropped
    expect(op(0.5 * S)).toBeCloseTo(0.5);
    expect(op(S)).toBe(1);
    expect(op(2 * S)).toBe(1);
    expect(op(3 * S)).toBeCloseTo(0.5);
    expect(op(3.5 * S)).toBeCloseTo(0.25);
  });

  it('fadeFactor takes the minimum when fades overlap', () => {
    const c = getClip(projectWith({ v1: [videoClip('v', 0, 2 * S, { fadeInUs: S, fadeOutUs: S })] }), 'v');
    expect(fadeFactor(c, S)).toBe(1);
    expect(fadeFactor(c, 0.5 * S)).toBeCloseTo(0.5);
    expect(fadeFactor(c, 1.5 * S)).toBeCloseTo(0.5);
  });
});

describe('transitions (centered on the cut)', () => {
  // a: [0,4s), b: [4s,8s) with a 1s transition → window [3.5s, 4.5s).
  const make = (type: 'dissolve' | 'fadeblack' | 'wipeleft' | 'wiperight', bStart = 4 * S) =>
    projectWith({ v1: [videoClip('a', 0, 4 * S), videoClip('b', bStart, 4 * S, { sourceStartUs: S, transitionIn: { type, durationUs: S } })] });
  const layer = (p: ReturnType<typeof make>, t: number, id: string) => evaluateVisualLayers(p, t).find((l) => l.clip.id === id);

  it('finds the adjacent predecessor only', () => {
    const p = make('dissolve');
    const v1 = p.tracks.find((t) => t.id === 'v1')!;
    expect(findTransitionPredecessor(v1, getClip(p, 'b'))?.id).toBe('a');
    const gap = make('dissolve', 5 * S);
    const g1 = gap.tracks.find((t) => t.id === 'v1')!;
    expect(findTransitionPredecessor(g1, getClip(gap, 'b'))).toBeNull();
  });

  it('dissolve: A at full opacity, B fades in with progress q', () => {
    const p = make('dissolve');
    // Before the window: only A.
    expect(ids(evaluateVisualLayers(p, 3.5 * S - 1))).toEqual(['a']);
    // Window start q=0: B invisible.
    expect(ids(evaluateVisualLayers(p, 3.5 * S))).toEqual(['a']);
    // Cut (middle) q=0.5.
    const mid = evaluateVisualLayers(p, 4 * S);
    expect(ids(mid)).toEqual(['a', 'b']);
    expect(mid[0].opacity).toBe(1);
    expect(mid[1].opacity).toBeCloseTo(0.5);
    // A is held past its out point; B is pre-rolled before its in point.
    expect(layer(p, 4.25 * S, 'a')!.localUs).toBe(4.25 * S);
    const pre = layer(p, 3.75 * S, 'b')!;
    expect(pre.localUs).toBe(-0.25 * S);
    expect(pre.opacity).toBeCloseTo(0.25);
    expect(pre.sourceUs).toBe(0.75 * S);
    // Just before the window end q→1.
    expect(layer(p, 4.5 * S - 1, 'b')!.opacity).toBeCloseTo(1, 5);
    // Window end (exclusive): only B, normally.
    const after = evaluateVisualLayers(p, 4.5 * S);
    expect(ids(after)).toEqual(['b']);
    expect(after[0].opacity).toBe(1);
  });

  it('fadeblack: A fades out over the first half, B fades in over the second', () => {
    const p = make('fadeblack');
    const q25 = evaluateVisualLayers(p, 3.75 * S);
    expect(ids(q25)).toEqual(['a']);
    expect(q25[0].opacity).toBeCloseTo(0.5);
    expect(evaluateVisualLayers(p, 4 * S)).toEqual([]); // q = 0.5: black
    const q75 = evaluateVisualLayers(p, 4.25 * S);
    expect(ids(q75)).toEqual(['b']);
    expect(q75[0].opacity).toBeCloseTo(0.5);
  });

  it('wipes reveal B over A from the given side', () => {
    const left = evaluateVisualLayers(make('wipeleft'), 4 * S);
    expect(ids(left)).toEqual(['a', 'b']);
    expect(left[0]).toMatchObject({ opacity: 1, wipe: null });
    expect(left[1].opacity).toBe(1);
    expect(left[1].wipe).toEqual({ from: 'left', progress: 0.5 });
    const right = evaluateVisualLayers(make('wiperight'), 3.75 * S);
    expect(right[1].wipe).toEqual({ from: 'right', progress: 0.25 });
  });

  it('a transition without an adjacent predecessor is ignored', () => {
    const p = make('dissolve', 5 * S);
    expect(evaluateVisualLayers(p, 4.75 * S)).toEqual([]);
    const l = evaluateVisualLayers(p, 5 * S);
    expect(ids(l)).toEqual(['b']);
    expect(l[0].opacity).toBe(1);
  });
});

describe('sourceTimeAt', () => {
  it('maps timeline to source with speed and rounds to integers', () => {
    const p = projectWith({
      v1: [videoClip('v', 2 * S, 2 * S, { sourceStartUs: S, speed: 1.5 })],
      v2: [textClip('t', 0, S)],
      a1: [audioClip('m', 0, 4 * S, { speed: 0.5, sourceStartUs: 3 * S })],
    });
    expect(sourceTimeAt(getClip(p, 'v'), 2 * S)).toBe(S);
    expect(sourceTimeAt(getClip(p, 'v'), 3 * S)).toBe(2.5 * S);
    expect(sourceTimeAt(getClip(p, 'v'), 2 * S + 1)).toBe(S + 2); // round(1.5)
    expect(sourceTimeAt(getClip(p, 'm'), 2 * S)).toBe(4 * S);
    expect(sourceTimeAt(getClip(p, 't'), 0.5 * S)).toBe(0);
  });
});

describe('activeCaption', () => {
  const p = cmd.setCaptions(projectWith({}), {
    segments: [
      { id: 'a', startUs: 0, endUs: S, text: 'one' },
      { id: 'b', startUs: S, endUs: 2 * S, text: 'two' },
      { id: 'c', startUs: 3 * S, endUs: 4 * S, text: 'three' },
    ],
  });
  it('uses half-open [start, end) boundaries', () => {
    expect(activeCaption(p, 0)?.id).toBe('a');
    expect(activeCaption(p, S - 1)?.id).toBe('a');
    expect(activeCaption(p, S)?.id).toBe('b');
    expect(activeCaption(p, 2 * S)).toBeNull();
    expect(activeCaption(p, 2.5 * S)).toBeNull();
    expect(activeCaption(p, 4 * S)).toBeNull();
  });
});

describe('audioSegments', () => {
  const p = projectWith(
    {
      v2: [videoClip('hiddenVid', 0, S)],
      v1: [videoClip('vidAudio', 0, 2 * S, { volume: 0.5 }), { ...videoClip('vidSilent', 2 * S, S), assetId: 'vid5silent' }, imageClip('img', 3 * S, S), videoClip('vidMuted', 4 * S, S, { muted: true })],
      a1: [audioClip('music', 0, 10 * S, { volume: 0.5, fadeInUs: S, gainPoints: [{ tUs: 0, gain: 1 }] }), audioClip('zeroVol', 0, S, { volume: 0 })],
      a2: [audioClip('mutedTrack', 0, S)],
    },
    (q) => {
      q.tracks[0].hidden = true;
      q.tracks[2].volume = 0.8;
      q.tracks[3].muted = true;
    },
  );

  it('includes only audible clips with audio, including hidden visual tracks', () => {
    const segs = audioSegments(p, assets);
    expect(segs.map((s) => s.clipId).sort()).toEqual(['hiddenVid', 'music', 'vidAudio']);
  });

  it('computes gain = clip volume × track volume and copies timing', () => {
    const segs = audioSegments(p, assets);
    const music = segs.find((s) => s.clipId === 'music')!;
    expect(music.gain).toBeCloseTo(0.4);
    expect(music).toMatchObject({ assetId: 'music', timelineStartUs: 0, durationUs: 10 * S, sourceStartUs: 0, speed: 1, fadeInUs: S, fadeOutUs: 0 });
    expect(music.gainPoints).toEqual([{ tUs: 0, gain: 1 }]);
    expect(segs.find((s) => s.clipId === 'vidAudio')!.gain).toBe(0.5);
  });

  it('skips clips whose asset is unknown', () => {
    const q = projectWith({ a1: [{ ...audioClip('ghost', 0, S), assetId: 'missing' }] });
    expect(audioSegments(q, assets)).toEqual([]);
  });
});

describe('segmentGainAt / interpGain', () => {
  const seg = (extra: Partial<AudioSegment> = {}): AudioSegment => ({
    clipId: 'x',
    assetId: 'music',
    timelineStartUs: 10 * S,
    durationUs: 4 * S,
    sourceStartUs: 0,
    speed: 1,
    gain: 0.8,
    fadeInUs: 0,
    fadeOutUs: 0,
    gainPoints: [],
    ...extra,
  });

  it('is zero outside the segment and static gain inside', () => {
    expect(segmentGainAt(seg(), 10 * S - 1)).toBe(0);
    expect(segmentGainAt(seg(), 14 * S)).toBe(0);
    expect(segmentGainAt(seg(), 12 * S)).toBe(0.8);
  });

  it('applies linear fades', () => {
    const s = seg({ fadeInUs: S, fadeOutUs: 2 * S });
    expect(segmentGainAt(s, 10 * S)).toBe(0);
    expect(segmentGainAt(s, 10.5 * S)).toBeCloseTo(0.4);
    expect(segmentGainAt(s, 11 * S)).toBeCloseTo(0.8);
    expect(segmentGainAt(s, 13 * S)).toBeCloseTo(0.4);
  });

  it('multiplies by interpolated automation', () => {
    const s = seg({ gainPoints: [{ tUs: S, gain: 1 }, { tUs: 3 * S, gain: 0 }] });
    expect(segmentGainAt(s, 10 * S)).toBeCloseTo(0.8); // before first point: holds first gain
    expect(segmentGainAt(s, 12 * S)).toBeCloseTo(0.4);
    expect(segmentGainAt(s, 13.5 * S)).toBe(0); // after last point: holds last gain
    const both = seg({ fadeInUs: 2 * S, gainPoints: [{ tUs: 0, gain: 0.5 }] });
    expect(segmentGainAt(both, 11 * S)).toBeCloseTo(0.8 * 0.5 * 0.5);
  });

  it('interpGain handles empty, single and coincident points', () => {
    expect(interpGain([], 5)).toBe(1);
    expect(interpGain([{ tUs: 10, gain: 0.3 }], 0)).toBe(0.3);
    expect(interpGain([{ tUs: 10, gain: 0.3 }], 99)).toBe(0.3);
    expect(interpGain([{ tUs: 0, gain: 0 }, { tUs: 10, gain: 1 }], 2.5)).toBeCloseTo(0.25);
    expect(interpGain([{ tUs: 5, gain: 0 }, { tUs: 5, gain: 1 }], 5)).toBe(0);
    expect(interpGain([{ tUs: 5, gain: 0 }, { tUs: 5, gain: 1 }], 6)).toBe(1);
  });
});

describe('exportPlan', () => {
  it('30 s at 30 fps is 900 frames', () => {
    const p = projectWith({ v1: [videoClip('a', 0, 10 * S), videoClip('b', 10 * S, 10 * S)], a1: [audioClip('m', 0, 30 * S)], v2: [textClip('t', 0, S)] });
    const plan = exportPlan(p, assets, { width: 1920, height: 1080, fps: 30 });
    expect(plan.durationUs).toBe(30 * S);
    expect(plan.frames).toBe(900);
    expect(plan.usedAssetIds.sort()).toEqual(['music', 'vid10']);
    expect(plan.audioSegments.map((s) => s.clipId).sort()).toEqual(['a', 'b', 'm']);
    expect(exportPlan(p, assets, { width: 1280, height: 720, fps: 24 }).frames).toBe(720);
    expect(exportPlan(p, assets, { width: 1280, height: 720, fps: 60 }).frames).toBe(1800);
  });

  it('frame-aligned (non-integer-ms) durations do not produce an extra frame', () => {
    const p = projectWith({ v2: [textClip('t', 0, frameToUs(2, 30))] });
    expect(exportPlan(p, assets, { width: 640, height: 360, fps: 30 }).frames).toBe(2);
    const q = projectWith({ v2: [textClip('t', 0, frameToUs(100, 24))] });
    expect(exportPlan(q, assets, { width: 640, height: 360, fps: 24 }).frames).toBe(100);
  });

  it('an empty project has zero frames', () => {
    expect(exportPlan(projectWith({}), assets, { width: 640, height: 360, fps: 30 })).toMatchObject({ durationUs: 0, frames: 0, usedAssetIds: [] });
  });
});

describe('textAnimation', () => {
  const t = (animation: TextClip['animation'], text = 'Hello') => getClip(projectWith({ v2: [textClip('t', 0, 2 * S, { animation, text })] }), 't') as TextClip;
  it('fade ramps in and out', () => {
    expect(textAnimation(t('fade'), 0).opacity).toBe(0);
    expect(textAnimation(t('fade'), S).opacity).toBe(1);
    expect(textAnimation(t('fade'), 2 * S).opacity).toBe(0);
  });
  it('typewriter reveals characters progressively', () => {
    const c = t('typewriter');
    expect(textAnimation(c, 0).chars).toBe(0);
    expect(textAnimation(c, S).chars).toBe(5);
  });
  it('none is static', () => {
    expect(textAnimation(t('none'), 0)).toEqual({ opacity: 1, dy: 0, scale: 1, chars: 5 });
  });
});

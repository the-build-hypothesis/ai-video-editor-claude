import { describe, it, expect } from 'vitest';
import * as cmd from '../../src/shared/commands';
import { CommandError } from '../../src/shared/commands';
import { ProjectSchema, clipEndUs, clipSpeed, type Clip, type Project, type VideoClip, type AudioClip } from '../../src/shared/model';
import { interpGain } from '../../src/shared/timeline-eval';
import { S, assets, ctx, emptyProject, videoClip, audioClip, imageClip, textClip, projectWith, getClip, trackOf, rng } from './helpers';

const MIN = 33_000;

describe('addClip', () => {
  it('adds a valid clip, applies schema defaults and keeps clips sorted by start', () => {
    let p = cmd.addClip(emptyProject(), { trackId: 'v1', clip: videoClip('b', 3 * S, S) }, ctx);
    p = cmd.addClip(p, { trackId: 'v1', clip: videoClip('a', 0, S) }, ctx);
    const v1 = p.tracks.find((t) => t.id === 'v1')!;
    expect(v1.clips.map((c) => c.id)).toEqual(['a', 'b']);
    const a = getClip(p, 'a') as VideoClip;
    expect(a.speed).toBe(1);
    expect(a.volume).toBe(1);
    expect(a.transform.scale).toBe(1);
    expect(a.transitionIn).toBeNull();
  });

  it('rejects kind/track mismatches', () => {
    const p = emptyProject();
    expect(() => cmd.addClip(p, { trackId: 'v1', clip: audioClip('x', 0, S) }, ctx)).toThrow(CommandError);
    expect(() => cmd.addClip(p, { trackId: 'a1', clip: videoClip('x', 0, S) }, ctx)).toThrow(CommandError);
    expect(() => cmd.addClip(p, { trackId: 'a1', clip: imageClip('x', 0, S) }, ctx)).toThrow(CommandError);
    expect(() => cmd.addClip(p, { trackId: 'a1', clip: textClip('x', 0, S) }, ctx)).toThrow(CommandError);
    // Visual clips of any visual kind are fine on video tracks.
    expect(() => cmd.addClip(p, { trackId: 'v2', clip: textClip('x', 0, S) }, ctx)).not.toThrow();
    expect(() => cmd.addClip(p, { trackId: 'v2', clip: imageClip('x', 0, S) }, ctx)).not.toThrow();
  });

  it('rejects missing assets, unknown tracks, locked tracks and duplicate ids', () => {
    const p = emptyProject();
    expect(() => cmd.addClip(p, { trackId: 'v1', clip: { ...videoClip('x', 0, S), assetId: 'nope' } }, ctx)).toThrow(/Asset nope not found/);
    expect(() => cmd.addClip(p, { trackId: 'zz', clip: videoClip('x', 0, S) }, ctx)).toThrow(CommandError);
    const locked = cmd.updateTrack(p, { trackId: 'v1', patch: { locked: true } });
    expect(() => cmd.addClip(locked, { trackId: 'v1', clip: videoClip('x', 0, S) }, ctx)).toThrow(/locked/);
    const one = cmd.addClip(p, { trackId: 'v1', clip: videoClip('x', 0, S) }, ctx);
    expect(() => cmd.addClip(one, { trackId: 'v2', clip: videoClip('x', 5 * S, S) }, ctx)).toThrow(/already exists/);
  });

  it('rejects clips longer than the available source media (accounting for sourceStart and speed)', () => {
    const p = emptyProject();
    expect(() => cmd.addClip(p, { trackId: 'v1', clip: videoClip('x', 0, 10 * S) }, ctx)).not.toThrow();
    expect(() => cmd.addClip(p, { trackId: 'v1', clip: videoClip('x', 0, 10 * S + 10) }, ctx)).toThrow(/exceeds/);
    expect(() => cmd.addClip(p, { trackId: 'v1', clip: videoClip('x', 0, 8 * S, { sourceStartUs: 2 * S }) }, ctx)).not.toThrow();
    expect(() => cmd.addClip(p, { trackId: 'v1', clip: videoClip('x', 0, 8.5 * S, { sourceStartUs: 2 * S }) }, ctx)).toThrow(/exceeds/);
    expect(() => cmd.addClip(p, { trackId: 'v1', clip: videoClip('x', 0, 5 * S, { speed: 2 }) }, ctx)).not.toThrow();
    expect(() => cmd.addClip(p, { trackId: 'v1', clip: videoClip('x', 0, 5.1 * S, { speed: 2 }) }, ctx)).toThrow(/exceeds/);
    // Images and text have no source limit.
    expect(() => cmd.addClip(p, { trackId: 'v1', clip: imageClip('x', 0, 600 * S) }, ctx)).not.toThrow();
  });

  it('rejects schema-invalid clips (non-integer times, unknown kind)', () => {
    const p = emptyProject();
    expect(() => cmd.addClip(p, { trackId: 'v1', clip: videoClip('x', 0.5, S) }, ctx)).toThrow();
    expect(() => cmd.addClip(p, { trackId: 'v1', clip: { ...videoClip('x', 0, S), kind: 'shader' } }, ctx)).toThrow();
    expect(() => cmd.addClip(p, { trackId: 'v1', clip: videoClip('x', -1, S) }, ctx)).toThrow();
  });
});

describe('moveClip', () => {
  const base = () => projectWith({ v1: [videoClip('c1', 2 * S, S)], v2: [textClip('t1', 0, S)], a1: [audioClip('m1', 0, S)] });

  it('moves and rounds to integer µs, clamping at 0', () => {
    expect(getClip(cmd.moveClip(base(), { clipId: 'c1', timelineStartUs: 5_000_000.6 }), 'c1').timelineStartUs).toBe(5_000_001);
    expect(getClip(cmd.moveClip(base(), { clipId: 'c1', timelineStartUs: -3 * S }), 'c1').timelineStartUs).toBe(0);
  });

  it('moves across tracks of the same kind only', () => {
    const p = cmd.moveClip(base(), { clipId: 'c1', timelineStartUs: S, trackId: 'v2' });
    expect(trackOf(p, 'c1')).toBe('v2');
    expect(p.tracks.find((t) => t.id === 'v1')!.clips).toHaveLength(0);
    expect(() => cmd.moveClip(base(), { clipId: 'c1', timelineStartUs: 0, trackId: 'a1' })).toThrow(CommandError);
    expect(() => cmd.moveClip(base(), { clipId: 'm1', timelineStartUs: 0, trackId: 'v1' })).toThrow(CommandError);
    expect(trackOf(cmd.moveClip(base(), { clipId: 'm1', timelineStartUs: 0, trackId: 'a2' }), 'm1')).toBe('a2');
  });

  it('rejects moves on or onto a locked track and unknown ids', () => {
    const lockedSrc = cmd.updateTrack(base(), { trackId: 'v1', patch: { locked: true } });
    expect(() => cmd.moveClip(lockedSrc, { clipId: 'c1', timelineStartUs: 0 })).toThrow(/locked/);
    const lockedDst = cmd.updateTrack(base(), { trackId: 'v2', patch: { locked: true } });
    expect(() => cmd.moveClip(lockedDst, { clipId: 'c1', timelineStartUs: 0, trackId: 'v2' })).toThrow(/locked/);
    expect(() => cmd.moveClip(base(), { clipId: 'nope', timelineStartUs: 0 })).toThrow(/not found/);
    expect(() => cmd.moveClip(base(), { clipId: 'c1', timelineStartUs: 0, trackId: 'nope' })).toThrow(/not found/);
  });
});

describe('trimClip', () => {
  // vid10 is 10s long. Clip occupies timeline [2s,6s) showing source [1s,5s).
  const base = (extra: Record<string, unknown> = {}, dur = 4 * S) => projectWith({ v1: [videoClip('c', 2 * S, dur, { sourceStartUs: S, ...extra })] });

  it('start trim shifts sourceStart so remaining frames stay in place (speed 1)', () => {
    const c = getClip(cmd.trimClip(base(), { clipId: 'c', startUs: 3 * S }, ctx), 'c') as VideoClip;
    expect(c.timelineStartUs).toBe(3 * S);
    expect(c.durationUs).toBe(3 * S);
    expect(c.sourceStartUs).toBe(2 * S);
    expect(clipEndUs(c)).toBe(6 * S);
  });

  it('start trim shifts sourceStart by delta × speed when speed ≠ 1', () => {
    const p = base({ speed: 2 }, 2 * S); // timeline [2s,4s) consumes source [1s,5s)
    const c = getClip(cmd.trimClip(p, { clipId: 'c', startUs: 2.5 * S }, ctx), 'c') as VideoClip;
    expect(c.sourceStartUs).toBe(2 * S);
    expect(c.durationUs).toBe(1.5 * S);
    // Source end stays the same: 2s + 1.5s*2 = 5s.
    expect(c.sourceStartUs + c.durationUs * c.speed).toBe(5 * S);
  });

  it('start edge cannot extend before source time 0', () => {
    const c = getClip(cmd.trimClip(base(), { clipId: 'c', startUs: 0 }, ctx), 'c') as VideoClip;
    expect(c.sourceStartUs).toBe(0);
    expect(c.timelineStartUs).toBe(S);
    expect(c.durationUs).toBe(5 * S);
    const fast = getClip(cmd.trimClip(base({ speed: 2 }, 2 * S), { clipId: 'c', startUs: 0 }, ctx), 'c') as VideoClip;
    expect(fast.sourceStartUs).toBe(0);
    expect(fast.timelineStartUs).toBe(1.5 * S);
    expect(clipEndUs(fast)).toBe(4 * S);
  });

  it('end edge cannot exceed asset duration (with speed)', () => {
    const c = getClip(cmd.trimClip(base(), { clipId: 'c', endUs: 30 * S }, ctx), 'c') as VideoClip;
    expect(c.durationUs).toBe(9 * S);
    const fast = getClip(cmd.trimClip(base({ speed: 2 }, 2 * S), { clipId: 'c', endUs: 30 * S }, ctx), 'c') as VideoClip;
    expect(fast.durationUs).toBe(4.5 * S);
    expect(fast.sourceStartUs + fast.durationUs * fast.speed).toBeLessThanOrEqual(10 * S);
  });

  it('enforces a minimum duration from either edge', () => {
    const e = getClip(cmd.trimClip(base(), { clipId: 'c', endUs: 2 * S }, ctx), 'c');
    expect(e.timelineStartUs).toBe(2 * S);
    expect(e.durationUs).toBe(MIN);
    const s = getClip(cmd.trimClip(base(), { clipId: 'c', startUs: 9 * S }, ctx), 'c');
    expect(clipEndUs(s)).toBe(6 * S);
    expect(s.durationUs).toBe(MIN);
  });

  it('clamps fades so they fit the trimmed duration', () => {
    const p = base({ fadeInUs: 2 * S, fadeOutUs: 2 * S });
    const c = getClip(cmd.trimClip(p, { clipId: 'c', endUs: 4 * S }, ctx), 'c');
    expect(c.durationUs).toBe(2 * S);
    expect(c.fadeInUs + c.fadeOutUs).toBeLessThanOrEqual(c.durationUs);
  });

  it('text and image clips are only bounded by timeline 0', () => {
    const p = projectWith({ v2: [textClip('t', 2 * S, S)], v1: [imageClip('i', 2 * S, S)] });
    const t = getClip(cmd.trimClip(p, { clipId: 't', startUs: -5 * S, endUs: 100 * S }, ctx), 't');
    expect(t.timelineStartUs).toBe(0);
    expect(t.durationUs).toBe(100 * S);
    const i = getClip(cmd.trimClip(p, { clipId: 'i', startUs: 0 }, ctx), 'i');
    expect(i.timelineStartUs).toBe(0);
    expect(i.durationUs).toBe(3 * S);
  });

  it('rejects trims on locked tracks', () => {
    const p = cmd.updateTrack(base(), { trackId: 'v1', patch: { locked: true } });
    expect(() => cmd.trimClip(p, { clipId: 'c', endUs: 3 * S }, ctx)).toThrow(/locked/);
  });
});

describe('splitClip', () => {
  // Timeline [2s,8s) at 1.5× consumes source [1s,10s) of vid10.
  const base = (extra: Record<string, unknown> = {}) =>
    projectWith({ v1: [videoClip('c', 2 * S, 6 * S, { sourceStartUs: S, speed: 1.5, ...extra })] });

  it('produces contiguous halves whose durations and source ranges add up', () => {
    const p = cmd.splitClip(base(), { clipId: 'c', atUs: 4 * S, newId: 'r' });
    const l = getClip(p, 'c') as VideoClip;
    const r = getClip(p, 'r') as VideoClip;
    expect(trackOf(p, 'r')).toBe('v1');
    expect(l.durationUs + r.durationUs).toBe(6 * S);
    expect(l.durationUs).toBe(2 * S);
    expect(clipEndUs(l)).toBe(r.timelineStartUs); // no gap / overlap
    expect(r.sourceStartUs).toBe(l.sourceStartUs + l.durationUs * l.speed);
    expect(r.sourceStartUs).toBe(4 * S);
    expect(r.speed).toBe(1.5);
    expect(r.sourceStartUs + r.durationUs * r.speed).toBe(10 * S);
  });

  it('rounds non-integer split points and source offsets to integers', () => {
    const p = cmd.splitClip(base(), { clipId: 'c', atUs: 3_333_333.4, newId: 'r' });
    const l = getClip(p, 'c');
    const r = getClip(p, 'r') as VideoClip;
    expect(r.timelineStartUs).toBe(3_333_333);
    expect(Number.isInteger(r.sourceStartUs)).toBe(true);
    expect(l.durationUs + r.durationUs).toBe(6 * S);
  });

  it('keeps fade-in and transition on the left half, fade-out on the right half', () => {
    const p = cmd.splitClip(base({ fadeInUs: 500_000, fadeOutUs: 700_000, transitionIn: { type: 'dissolve', durationUs: S } }), {
      clipId: 'c',
      atUs: 5 * S,
      newId: 'r',
    });
    const l = getClip(p, 'c') as VideoClip;
    const r = getClip(p, 'r') as VideoClip;
    expect(l.fadeInUs).toBe(500_000);
    expect(l.fadeOutUs).toBe(0);
    expect(r.fadeInUs).toBe(0);
    expect(r.fadeOutUs).toBe(700_000);
    expect(l.transitionIn).toEqual({ type: 'dissolve', durationUs: S });
    expect(r.transitionIn).toBeNull();
  });

  it('clamps a fade that no longer fits a half', () => {
    const p = cmd.splitClip(base({ fadeInUs: 4 * S }), { clipId: 'c', atUs: 3 * S, newId: 'r' });
    const l = getClip(p, 'c');
    expect(l.fadeInUs).toBeLessThanOrEqual(l.durationUs);
  });

  it('splits gain automation without changing the audible envelope', () => {
    const points = [
      { tUs: 0, gain: 1 },
      { tUs: 2 * S, gain: 0 },
      { tUs: 4 * S, gain: 1 },
    ];
    const p0 = projectWith({ a1: [audioClip('m', 0, 6 * S, { gainPoints: points })] });
    const p = cmd.splitClip(p0, { clipId: 'm', atUs: 3 * S, newId: 'r' });
    const l = getClip(p, 'm') as AudioClip;
    const r = getClip(p, 'r') as AudioClip;
    // Points are re-based to each half's start and stay inside the half.
    for (const g of l.gainPoints) expect(g.tUs).toBeLessThanOrEqual(l.durationUs);
    for (const g of r.gainPoints) expect(g.tUs).toBeGreaterThanOrEqual(0);
    expect(l.gainPoints.some((g) => g.tUs === 2 * S && g.gain === 0)).toBe(true);
    expect(r.gainPoints.some((g) => g.tUs === S && g.gain === 1)).toBe(true);
    // The automation envelope on the timeline is identical before and after the split.
    for (let t = 0; t < 6 * S; t += 100_000) {
      const before = interpGain(points, t);
      const after = t < 3 * S ? interpGain(l.gainPoints, t) : interpGain(r.gainPoints, t - 3 * S);
      expect(after).toBeCloseTo(before, 6);
    }
  });

  it('rejects split points at/near/outside the edges', () => {
    for (const at of [2 * S, 2 * S + 10_000, 8 * S, 8 * S - 10_000, 0, 9 * S]) {
      expect(() => cmd.splitClip(base(), { clipId: 'c', atUs: at })).toThrow(CommandError);
    }
    expect(() => cmd.splitClip(base(), { clipId: 'c', atUs: 2 * S + MIN })).not.toThrow();
  });

  it('splits text clips and generates a fresh id when none given', () => {
    const p = cmd.splitClip(projectWith({ v2: [textClip('t', 0, 2 * S)] }), { clipId: 't', atUs: S });
    const v2 = p.tracks.find((t) => t.id === 'v2')!;
    expect(v2.clips).toHaveLength(2);
    expect(v2.clips[1].id).not.toBe('t');
    expect(v2.clips.map((c) => c.durationUs)).toEqual([S, S]);
  });
});

describe('updateClip', () => {
  const base = () =>
    projectWith({
      v1: [videoClip('c', 0, 10 * S, { transform: { x: 10, y: 20, scale: 1.5, crop: { left: 0.1, top: 0.2, right: 0, bottom: 0 } } })],
    });

  it('merges transform and crop partially', () => {
    const c = getClip(cmd.updateClip(base(), { clipId: 'c', patch: { transform: { x: 99, crop: { right: 0.3 } } } }, ctx), 'c') as VideoClip;
    expect(c.transform.x).toBe(99);
    expect(c.transform.y).toBe(20);
    expect(c.transform.scale).toBe(1.5);
    expect(c.transform.crop).toEqual({ left: 0.1, top: 0.2, right: 0.3, bottom: 0 });
  });

  it('merges adjust partially', () => {
    let p = cmd.updateClip(base(), { clipId: 'c', patch: { adjust: { brightness: 0.2 } } }, ctx);
    p = cmd.updateClip(p, { clipId: 'c', patch: { adjust: { contrast: -0.3 } } }, ctx);
    expect((getClip(p, 'c') as VideoClip).adjust).toEqual({ brightness: 0.2, contrast: -0.3, saturation: 0 });
  });

  it('rejects invalid values', () => {
    expect(() => cmd.updateClip(base(), { clipId: 'c', patch: { volume: 5 } }, ctx)).toThrow(CommandError);
    expect(() => cmd.updateClip(base(), { clipId: 'c', patch: { speed: 0.1 } }, ctx)).toThrow(CommandError);
    expect(() => cmd.updateClip(base(), { clipId: 'c', patch: { transform: { opacity: 2 } } }, ctx)).toThrow(CommandError);
    expect(() => cmd.updateClip(base(), { clipId: 'c', patch: { transform: { crop: { left: 1 } } } }, ctx)).toThrow(CommandError);
    expect(() => cmd.updateClip(base(), { clipId: 'c', patch: { durationUs: 1.5 } }, ctx)).toThrow(CommandError);
  });

  it('cannot change kind, id or assetId', () => {
    const p = cmd.updateClip(base(), { clipId: 'c', patch: { kind: 'audio', id: 'zzz', assetId: 'music', volume: 0.5 } }, ctx);
    const c = getClip(p, 'c') as VideoClip;
    expect(c.kind).toBe('video');
    expect(c.assetId).toBe('vid10');
    expect(c.volume).toBe(0.5);
    expect(() => getClip(p, 'zzz')).toThrow();
  });

  it('speed change clamps duration to available media; fades clamped to duration', () => {
    const c = getClip(cmd.updateClip(base(), { clipId: 'c', patch: { speed: 2 } }, ctx), 'c') as VideoClip;
    expect(c.durationUs).toBe(5 * S);
    const f = getClip(cmd.updateClip(base(), { clipId: 'c', patch: { fadeInUs: 8 * S, fadeOutUs: 8 * S } }, ctx), 'c');
    expect(f.fadeInUs + f.fadeOutUs).toBeLessThanOrEqual(f.durationUs);
  });

  it('merges text style partially', () => {
    const p = projectWith({ v2: [textClip('t', 0, S, { style: { fontSize: 50, color: '#ff0000' } })] });
    const t = getClip(cmd.updateClip(p, { clipId: 't', patch: { style: { bold: false } } }, ctx), 't');
    if (t.kind !== 'text') throw new Error('expected text');
    expect(t.style.fontSize).toBe(50);
    expect(t.style.color).toBe('#ff0000');
    expect(t.style.bold).toBe(false);
    expect(() => cmd.updateClip(p, { clipId: 't', patch: { style: { color: 'red;}</style>' } } }, ctx)).toThrow(CommandError);
  });
});

describe('duplicate / paste / remove / ripple', () => {
  const base = () => projectWith({ v1: [videoClip('c1', 0, 2 * S), videoClip('c2', 2 * S, 3 * S), videoClip('c3', 6 * S, S)], v2: [textClip('t', 3 * S, S)] });

  it('duplicateClip places a copy after the original (or at atUs) on the same track', () => {
    const p = cmd.duplicateClip(base(), { clipId: 'c1', newId: 'dup' });
    const d = getClip(p, 'dup');
    expect(trackOf(p, 'dup')).toBe('v1');
    expect(d.timelineStartUs).toBe(2 * S);
    expect(d.durationUs).toBe(2 * S);
    expect(getClip(cmd.duplicateClip(base(), { clipId: 'c1', newId: 'd2', atUs: 9 * S }), 'd2').timelineStartUs).toBe(9 * S);
    expect(cmd.duplicateClip(base(), { clipId: 'c1' }).tracks.find((t) => t.id === 'v1')!.clips).toHaveLength(4);
  });

  it('pasteClips preserves relative offsets, assigns new ids and falls back to a track of the right kind', () => {
    const src = base();
    const clipboard = [
      { trackId: 'v1', clip: getClip(src, 'c2') },
      { trackId: 'gone', clip: getClip(src, 't') },
    ];
    const p = cmd.pasteClips(src, { clips: clipboard, atUs: 10 * S }, ctx);
    const all = p.tracks.flatMap((t) => t.clips.map((c) => ({ t: t.id, c })));
    const pasted = all.filter(({ c }) => c.timelineStartUs >= 10 * S);
    expect(pasted).toHaveLength(2);
    const v = pasted.find(({ c }) => c.kind === 'video')!;
    const t = pasted.find(({ c }) => c.kind === 'text')!;
    expect(v.c.timelineStartUs).toBe(10 * S);
    expect(t.c.timelineStartUs).toBe(11 * S);
    expect(v.t).toBe('v1');
    expect(t.t).toBe('v2'); // first video track
    expect(new Set(all.map(({ c }) => c.id)).size).toBe(all.length);
    expect(cmd.pasteClips(src, { clips: [], atUs: 0 }, ctx)).toBe(src);
  });

  it('removeClips removes and rejects unknown ids', () => {
    const p = cmd.removeClips(base(), { clipIds: ['c1', 't'] });
    expect(p.tracks.flatMap((t) => t.clips.map((c) => c.id))).toEqual(['c2', 'c3']);
    expect(() => cmd.removeClips(base(), { clipIds: ['nope'] })).toThrow(CommandError);
  });

  it('rippleDelete closes the gap on the same track only', () => {
    const p = cmd.rippleDelete(base(), { clipId: 'c1' });
    expect(getClip(p, 'c2').timelineStartUs).toBe(0);
    expect(getClip(p, 'c3').timelineStartUs).toBe(4 * S);
    expect(getClip(p, 't').timelineStartUs).toBe(3 * S);
    // Deleting a middle clip: earlier clips untouched.
    const q = cmd.rippleDelete(base(), { clipId: 'c2' });
    expect(getClip(q, 'c1').timelineStartUs).toBe(0);
    expect(getClip(q, 'c3').timelineStartUs).toBe(3 * S);
  });

  it('setTransition only applies to visual media clips', () => {
    const p = cmd.setTransition(base(), { clipId: 'c2', transition: { type: 'wipeleft', durationUs: S } });
    expect((getClip(p, 'c2') as VideoClip).transitionIn?.type).toBe('wipeleft');
    expect(() => cmd.setTransition(base(), { clipId: 't', transition: { type: 'dissolve', durationUs: S } })).toThrow(CommandError);
    expect(() => cmd.setTransition(base(), { clipId: 'c2', transition: { type: 'dissolve', durationUs: 10 } })).toThrow(CommandError);
  });
});

describe('tracks', () => {
  it('addTrack puts video tracks on top and audio tracks at the bottom with sequential names', () => {
    let p = cmd.addTrack(emptyProject(), { kind: 'video', id: 'v3' });
    p = cmd.addTrack(p, { kind: 'audio', id: 'a3' });
    expect(p.tracks.map((t) => t.id)).toEqual(['v3', 'v2', 'v1', 'a1', 'a2', 'a3']);
    expect(p.tracks[0].name).toBe('V3');
    expect(p.tracks[5].name).toBe('A3');
  });

  it('removeTrack keeps at least one track of each kind and respects locks', () => {
    let p = cmd.removeTrack(emptyProject(), { trackId: 'v2' });
    expect(p.tracks.map((t) => t.id)).toEqual(['v1', 'a1', 'a2']);
    expect(() => cmd.removeTrack(p, { trackId: 'v1' })).toThrow(/at least one video/);
    p = cmd.updateTrack(p, { trackId: 'a1', patch: { locked: true } });
    expect(() => cmd.removeTrack(p, { trackId: 'a1' })).toThrow(/locked/);
    expect(() => cmd.removeTrack(p, { trackId: 'nope' })).toThrow(CommandError);
  });

  it('reorderTrack swaps within a kind group and is a no-op at the group boundary', () => {
    const p0 = emptyProject();
    expect(cmd.reorderTrack(p0, { trackId: 'v1', direction: -1 }).tracks.map((t) => t.id)).toEqual(['v1', 'v2', 'a1', 'a2']);
    expect(cmd.reorderTrack(p0, { trackId: 'v1', direction: 1 })).toBe(p0);
    expect(cmd.reorderTrack(p0, { trackId: 'v2', direction: -1 })).toBe(p0);
    expect(cmd.reorderTrack(p0, { trackId: 'a1', direction: 1 }).tracks.map((t) => t.id)).toEqual(['v2', 'v1', 'a2', 'a1']);
    expect(() => cmd.reorderTrack(p0, { trackId: 'nope', direction: 1 })).toThrow(CommandError);
  });

  it('updateTrack validates the patch', () => {
    const p = cmd.updateTrack(emptyProject(), { trackId: 'a1', patch: { muted: true, volume: 0.5, name: 'Music' } });
    const a1 = p.tracks.find((t) => t.id === 'a1')!;
    expect([a1.muted, a1.volume, a1.name]).toEqual([true, 0.5, 'Music']);
    expect(() => cmd.updateTrack(emptyProject(), { trackId: 'a1', patch: { volume: 9 } })).toThrow(CommandError);
  });
});

describe('settings', () => {
  it('updateSettings applies aspect presets and validates', () => {
    const p = cmd.updateSettings(emptyProject(), { patch: { fps: 25 }, aspect: '9:16' });
    expect(p.settings).toMatchObject({ width: 1080, height: 1920, fps: 25 });
    expect(() => cmd.updateSettings(emptyProject(), { patch: { width: 1001 } })).toThrow(CommandError);
    expect(() => cmd.updateSettings(emptyProject(), { patch: { fps: 29 as never } })).toThrow(CommandError);
  });

  it('renameProject trims, truncates and defaults', () => {
    expect(cmd.renameProject(emptyProject(), { name: '  Hi  ' }).name).toBe('Hi');
    expect(cmd.renameProject(emptyProject(), { name: '   ' }).name).toBe('Untitled');
    expect(cmd.renameProject(emptyProject(), { name: 'x'.repeat(500) }).name).toHaveLength(120);
  });
});

describe('captions', () => {
  const seg = (id: string, s: number, e: number, text = id) => ({ id, startUs: s, endUs: e, text });

  it('setCaptions rounds, sorts and records source info', () => {
    const p = cmd.setCaptions(emptyProject(), { segments: [seg('b', 2 * S, 3 * S), seg('a', 0.4, S + 0.6)], sourceAssetId: 'vid10', language: 'en' });
    expect(p.captions.segments.map((s) => [s.id, s.startUs, s.endUs])).toEqual([
      ['a', 0, S + 1],
      ['b', 2 * S, 3 * S],
    ]);
    expect(p.captions.sourceAssetId).toBe('vid10');
    expect(p.captions.language).toBe('en');
    expect(() => cmd.setCaptions(emptyProject(), { segments: [seg('x', S, S)] })).toThrow(CommandError);
  });

  it('updateCaption enforces end > start and resorts', () => {
    const p = cmd.setCaptions(emptyProject(), { segments: [seg('a', 0, S), seg('b', 2 * S, 3 * S)] });
    const q = cmd.updateCaption(p, { id: 'a', patch: { startUs: 4 * S, endUs: 5 * S, text: 'moved' } });
    expect(q.captions.segments.map((s) => s.id)).toEqual(['b', 'a']);
    expect(q.captions.segments[1].text).toBe('moved');
    expect(() => cmd.updateCaption(p, { id: 'a', patch: { endUs: 0 } })).toThrow(/after start/);
    expect(() => cmd.updateCaption(p, { id: 'zz', patch: { text: 'x' } })).toThrow(/not found/);
  });

  it('addCaption / removeCaption', () => {
    let p = cmd.addCaption(emptyProject(), { startUs: 2 * S, endUs: 3 * S, text: 'two' });
    p = cmd.addCaption(p, { startUs: 0, endUs: S, text: 'one' });
    expect(p.captions.segments.map((s) => s.text)).toEqual(['one', 'two']);
    expect(() => cmd.addCaption(p, { startUs: 3 * S, endUs: 2 * S, text: 'bad' })).toThrow(CommandError);
    p = cmd.removeCaption(p, { id: p.captions.segments[0].id });
    expect(p.captions.segments.map((s) => s.text)).toEqual(['two']);
  });

  it('updateCaptionSettings merges style and validates', () => {
    const p = cmd.updateCaptionSettings(emptyProject(), { patch: { burnIn: false, style: { position: 'top' } } });
    expect(p.captions.burnIn).toBe(false);
    expect(p.captions.style.position).toBe('top');
    expect(p.captions.style.fontSize).toBe(54);
    expect(() => cmd.updateCaptionSettings(emptyProject(), { patch: { style: { color: 'javascript:' } } })).toThrow(CommandError);
  });
});

describe('duckUnderCaptions', () => {
  const caps = [
    { id: 's1', startUs: 5 * S, endUs: 7 * S, text: 'a' },
    { id: 's2', startUs: 7.2 * S, endUs: 8 * S, text: 'b' }, // merged with s1 (gap < 2 × ramp)
    { id: 's3', startUs: 15 * S, endUs: 16 * S, text: 'c' },
    { id: 's4', startUs: 30 * S, endUs: 31 * S, text: 'outside' },
  ];
  const base = () => cmd.setCaptions(projectWith({ a1: [audioClip('m', 2 * S, 20 * S)], v2: [textClip('t', 0, S)] }), { segments: caps });

  it('produces ramped gain points relative to clip start, inside the clip', () => {
    const p = cmd.duckUnderCaptions(base(), { clipId: 'm', duckGain: 0.2 });
    const m = getClip(p, 'm') as AudioClip;
    expect(m.gainPoints).toEqual([
      { tUs: 2.75 * S, gain: 1 },
      { tUs: 3 * S, gain: 0.2 },
      { tUs: 6 * S, gain: 0.2 },
      { tUs: 6.25 * S, gain: 1 },
      { tUs: 12.75 * S, gain: 1 },
      { tUs: 13 * S, gain: 0.2 },
      { tUs: 14 * S, gain: 0.2 },
      { tUs: 14.25 * S, gain: 1 },
    ]);
    for (const g of m.gainPoints) {
      expect(g.tUs).toBeGreaterThanOrEqual(0);
      expect(g.tUs).toBeLessThanOrEqual(m.durationUs);
    }
  });

  it('drops points that would fall outside a clip partially overlapping speech', () => {
    const p0 = cmd.setCaptions(projectWith({ a1: [audioClip('m', 6 * S, 4 * S)] }), { segments: caps.slice(0, 2) });
    const m = getClip(cmd.duckUnderCaptions(p0, { clipId: 'm', duckGain: 0.3 }), 'm') as AudioClip;
    expect(m.gainPoints).toEqual([
      { tUs: 2 * S, gain: 0.3 },
      { tUs: 2.25 * S, gain: 1 },
    ]);
  });

  it('rejects clips without audio', () => {
    expect(() => cmd.duckUnderCaptions(base(), { clipId: 't', duckGain: 0.2 })).toThrow(CommandError);
  });
});

describe('property: random edit sequences keep the project valid', () => {
  function seedProject(): Project {
    return projectWith({
      v2: [textClip('t0', S, 3 * S)],
      v1: [videoClip('v0', 0, 4 * S, { sourceStartUs: S }), videoClip('v1x', 4 * S, 3 * S, { speed: 1.5, sourceStartUs: 500_000 }), imageClip('i0', 8 * S, 2 * S)],
      a1: [audioClip('m0', 0, 20 * S, { gainPoints: [{ tUs: 0, gain: 1 }, { tUs: 10 * S, gain: 0.5 }] })],
      a2: [audioClip('m1', 3 * S, 7 * S, { speed: 0.75 })],
    });
  }

  function allClips(p: Project): { track: string; clip: Clip }[] {
    return p.tracks.flatMap((t) => t.clips.map((clip) => ({ track: t.id, clip })));
  }

  function checkInvariants(p: Project) {
    expect(() => ProjectSchema.parse(p)).not.toThrow();
    for (const { clip } of allClips(p)) {
      for (const k of ['timelineStartUs', 'durationUs', 'fadeInUs', 'fadeOutUs'] as const) expect(Number.isInteger(clip[k])).toBe(true);
      expect(clip.timelineStartUs).toBeGreaterThanOrEqual(0);
      expect(clip.durationUs).toBeGreaterThanOrEqual(MIN);
      if (clip.kind !== 'text') {
        expect(Number.isInteger(clip.sourceStartUs)).toBe(true);
        expect(clip.sourceStartUs).toBeGreaterThanOrEqual(0);
        const a = assets[clip.assetId];
        if (a.durationUs !== null) {
          // Rounding the right half's sourceStart may add at most 0.5µs.
          expect(clip.sourceStartUs + clip.durationUs * clipSpeed(clip)).toBeLessThanOrEqual(a.durationUs + 1);
        }
      }
    }
  }

  it('200 random move/trim/split ops (seeded)', () => {
    const rand = rng(0xc0ffee);
    let p = seedProject();
    let applied = 0;
    let splits = 0;
    for (let i = 0; i < 200; i++) {
      const clips = allClips(p);
      const { track, clip } = clips[Math.floor(rand() * clips.length)];
      const op = Math.floor(rand() * 3);
      try {
        if (op === 0) {
          const sameKind = p.tracks.filter((t) => t.kind === p.tracks.find((x) => x.id === track)!.kind);
          const target = sameKind[Math.floor(rand() * sameKind.length)].id;
          p = cmd.moveClip(p, { clipId: clip.id, timelineStartUs: rand() * 30 * S - 2 * S, trackId: target });
        } else if (op === 1) {
          const edge = rand() < 0.5 ? 'startUs' : 'endUs';
          const at = clip.timelineStartUs + (rand() * 1.6 - 0.3) * clip.durationUs + (rand() - 0.5) * 3 * S;
          p = cmd.trimClip(p, { clipId: clip.id, [edge]: at }, ctx);
        } else {
          const at = clip.timelineStartUs + rand() * clip.durationUs;
          const newId = `s${i}`;
          const next = cmd.splitClip(p, { clipId: clip.id, atUs: at, newId });
          const l = getClip(next, clip.id);
          const r = getClip(next, newId);
          expect(l.durationUs + r.durationUs).toBe(clip.durationUs);
          expect(clipEndUs(l)).toBe(r.timelineStartUs);
          expect(l.timelineStartUs).toBe(clip.timelineStartUs);
          if (l.kind !== 'text' && r.kind !== 'text') {
            expect(r.sourceStartUs).toBe(Math.round(l.sourceStartUs + l.durationUs * clipSpeed(l)));
          }
          p = next;
          splits++;
        }
        applied++;
      } catch (e) {
        if (!(e instanceof CommandError)) throw e;
      }
      checkInvariants(p);
    }
    expect(applied).toBeGreaterThan(150);
    expect(splits).toBeGreaterThan(20);
  });

  it('move/split-only sequences preserve each original clip’s total duration and source coverage', () => {
    const rand = rng(42);
    let p = seedProject();
    const original = new Map(allClips(p).map(({ clip }) => [clip.id, clip]));
    const family = new Map<string, string>([...original.keys()].map((id) => [id, id]));
    for (let i = 0; i < 200; i++) {
      const clips = allClips(p);
      const { clip } = clips[Math.floor(rand() * clips.length)];
      try {
        if (rand() < 0.4) {
          p = cmd.moveClip(p, { clipId: clip.id, timelineStartUs: Math.round(rand() * 40 * S) });
        } else {
          const newId = `s${i}`;
          p = cmd.splitClip(p, { clipId: clip.id, atUs: clip.timelineStartUs + rand() * clip.durationUs, newId });
          family.set(newId, family.get(clip.id)!);
        }
      } catch (e) {
        if (!(e instanceof CommandError)) throw e;
      }
    }
    for (const [rootId, orig] of original) {
      const pieces = allClips(p)
        .map(({ clip }) => clip)
        .filter((c) => family.get(c.id) === rootId);
      expect(pieces.reduce((s, c) => s + c.durationUs, 0)).toBe(orig.durationUs);
      if (orig.kind === 'text') continue;
      // Pieces tile the original source range without gaps/overlaps (±1µs rounding per cut).
      const media = pieces as Exclude<Clip, { kind: 'text' }>[];
      media.sort((a, b) => a.sourceStartUs - b.sourceStartUs);
      let cursor = orig.sourceStartUs;
      for (const c of media) {
        expect(Math.abs(c.sourceStartUs - cursor)).toBeLessThanOrEqual(1);
        cursor = c.sourceStartUs + c.durationUs * clipSpeed(c);
      }
      expect(Math.abs(cursor - (orig.sourceStartUs + orig.durationUs * clipSpeed(orig)))).toBeLessThanOrEqual(1);
    }
    expect(family.size).toBeGreaterThan(original.size + 20);
  });
});

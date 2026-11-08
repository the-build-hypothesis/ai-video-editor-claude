import { describe, it, expect } from 'vitest';
import * as cmd from '../../src/shared/commands';
import { ProjectSchema, clipEndUs } from '../../src/shared/model';
import { S, projectWith, videoClip } from './helpers';

const base = () =>
  cmd.setCaptions(
    projectWith({ v1: [videoClip('a', 0, 10 * S), videoClip('b', 10 * S, 5 * S, { assetId: 'vid10' })] }),
    {
      segments: [
        { id: 'c1', startUs: 1 * S, endUs: 2 * S, text: 'one' },
        { id: 'c2', startUs: 3.2 * S, endUs: 3.8 * S, text: 'inside' },
        { id: 'c3', startUs: 6 * S, endUs: 7 * S, text: 'later' },
        { id: 'c4', startUs: 11 * S, endUs: 12 * S, text: 'next clip' },
      ],
    },
  );

describe('removeRangesFromClip', () => {
  it('cuts ranges, ripples the track, keeps source mapping, shifts captions', () => {
    const p = cmd.removeRangesFromClip(base(), { clipId: 'a', ranges: [{ startUs: 3 * S, endUs: 4 * S }, { startUs: 8 * S, endUs: 9 * S }] });
    expect(ProjectSchema.safeParse(p).success).toBe(true);
    const v1 = p.tracks.find((t) => t.id === 'v1')!.clips;
    // a split into [0,3) [3,7) [7,8) after ripple; b moved from 10 → 8
    const pieces = v1.filter((c) => c.id === 'a' || c.id.startsWith('a_'));
    expect(pieces.map((c) => [c.timelineStartUs, c.durationUs])).toEqual([
      [0, 3 * S],
      [3 * S, 4 * S],
      [7 * S, 1 * S],
    ]);
    // Source continuity: second piece starts at source 4s, third at 9s.
    expect(pieces.map((c) => (c.kind === 'video' ? c.sourceStartUs : -1))).toEqual([0, 4 * S, 9 * S]);
    const b = v1.find((c) => c.id === 'b')!;
    expect(b.timelineStartUs).toBe(8 * S);
    // No gaps on the track.
    for (let i = 1; i < v1.length; i++) expect(v1[i].timelineStartUs).toBe(clipEndUs(v1[i - 1]));
    // Captions: c2 (inside cut) removed; c3 shifted by 1s; c4 shifted by 2s.
    const caps = Object.fromEntries(p.captions.segments.map((s) => [s.id, [s.startUs, s.endUs]]));
    expect(caps.c2).toBeUndefined();
    expect(caps.c1).toEqual([1 * S, 2 * S]);
    expect(caps.c3).toEqual([5 * S, 6 * S]);
    expect(caps.c4).toEqual([9 * S, 10 * S]);
  });

  it('ignores ranges outside the clip or shorter than a frame and is a no-op when nothing remains', () => {
    const p0 = base();
    expect(cmd.removeRangesFromClip(p0, { clipId: 'a', ranges: [{ startUs: 20 * S, endUs: 21 * S }, { startUs: 1 * S, endUs: 1 * S + 1000 }] })).toBe(p0);
  });

  it('clamps a range that extends past the clip end', () => {
    const p = cmd.removeRangesFromClip(base(), { clipId: 'a', ranges: [{ startUs: 9 * S, endUs: 12 * S }] });
    const v1 = p.tracks.find((t) => t.id === 'v1')!.clips;
    expect(v1.find((c) => c.id === 'a')!.durationUs).toBe(9 * S);
    expect(v1.find((c) => c.id === 'b')!.timelineStartUs).toBe(9 * S);
  });
});

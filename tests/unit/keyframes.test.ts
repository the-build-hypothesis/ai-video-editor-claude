import { describe, it, expect } from 'vitest';
import * as cmd from '../../src/shared/commands';
import { effectiveTransform, evaluateVisualLayers, keyframeValuesAt } from '../../src/shared/timeline-eval';
import { ProjectSchema, type VideoClip } from '../../src/shared/model';
import { S, ctx, projectWith, videoClip, getClip } from './helpers';

const animated = () => {
  let p = projectWith({ v1: [videoClip('a', 0, 10 * S)] });
  p = cmd.setTransformAt(p, { clipId: 'a', localUs: 0, patch: { x: 0, opacity: 1 }, forceKeyframe: true });
  p = cmd.setTransformAt(p, { clipId: 'a', localUs: 4 * S, patch: { x: 400, scale: 2, opacity: 0.5 } });
  return p;
};

describe('keyframes', () => {
  it('interpolates linearly and holds outside the key range', () => {
    const c = getClip(animated(), 'a') as VideoClip;
    expect(c.keyframes.map((k) => k.tUs)).toEqual([0, 4 * S]);
    expect(effectiveTransform(c, 2 * S)).toMatchObject({ x: 200, scale: 1.5, opacity: 0.75 });
    expect(effectiveTransform(c, 8 * S)).toMatchObject({ x: 400, scale: 2, opacity: 0.5 });
    expect(keyframeValuesAt([], 0)).toBeNull();
    // Layers carry the effective transform used by preview and export.
    const [layer] = evaluateVisualLayers(animated(), 1 * S);
    expect(layer.transform.x).toBe(100);
  });

  it('without keyframes setTransformAt edits the base transform; existing key is replaced within tolerance', () => {
    let p = projectWith({ v1: [videoClip('a', 0, 10 * S)] });
    p = cmd.setTransformAt(p, { clipId: 'a', localUs: 3 * S, patch: { x: 50 } });
    const c = getClip(p, 'a') as VideoClip;
    expect(c.keyframes).toEqual([]);
    expect(c.transform.x).toBe(50);
    const q = cmd.setTransformAt(animated(), { clipId: 'a', localUs: 4 * S + 5000, patch: { x: 300 } });
    expect((getClip(q, 'a') as VideoClip).keyframes.map((k) => [k.tUs, k.x])).toEqual([[0, 0], [4 * S + 5000, 300]]);
  });

  it('split keeps motion continuous on both sides', () => {
    const p = cmd.splitClip(animated(), { clipId: 'a', atUs: 2 * S, newId: 'b' });
    const a = getClip(p, 'a') as VideoClip;
    const b = getClip(p, 'b') as VideoClip;
    for (const t of [0, 1 * S, 2 * S - 1]) expect(effectiveTransform(a, t).x).toBeCloseTo(effectiveTransform(getClip(animated(), 'a') as VideoClip, t).x, 3);
    for (const t of [0, 1 * S, 5 * S]) expect(effectiveTransform(b, t).x).toBeCloseTo(effectiveTransform(getClip(animated(), 'a') as VideoClip, 2 * S + t).x, 3);
    expect(ProjectSchema.safeParse(p).success).toBe(true);
  });

  it('trimming the start keeps keys at the same timeline positions', () => {
    const p = cmd.trimClip(animated(), { clipId: 'a', startUs: 1 * S }, ctx);
    const c = getClip(p, 'a') as VideoClip;
    expect(c.timelineStartUs).toBe(1 * S);
    // Timeline 3s was local 3s, now local 2s — same value (x = 300).
    expect(effectiveTransform(c, 2 * S).x).toBeCloseTo(300, 6);
    expect(effectiveTransform(c, 0).x).toBeCloseTo(100, 6);
  });

  it('removing the last keyframe bakes its values into the base transform', () => {
    let p = animated();
    p = cmd.removeKeyframe(p, { clipId: 'a', tUs: 0 });
    p = cmd.removeKeyframe(p, { clipId: 'a', tUs: 4 * S });
    const c = getClip(p, 'a') as VideoClip;
    expect(c.keyframes).toEqual([]);
    expect(c.transform).toMatchObject({ x: 400, scale: 2, opacity: 0.5 });
  });
});

import { describe, it, expect } from 'vitest';
import { filterPlanTargets, parsePlan } from '../../src/worker/lib/plan';
import { mapTranscription } from '../../src/worker/openai';
import { shouldSnapshot, thumbnailAssetId, REVISION_MIN_INTERVAL_MS } from '../../src/worker/routes/projects';
import { createEmptyProject, ProjectSchema } from '../../src/shared/model';
import type { AiOperation } from '../../src/shared/ai-actions';

const nullOp: AiOperation = {
  type: 'addText', clipId: null, trackId: null, text: null, startSec: null, endSec: null, durationSec: null, atSec: null, volume: null,
  fadeInSec: null, fadeOutSec: null, transition: null, position: null, fontSize: null, color: null, speed: null, brightness: null,
  contrast: null, saturation: null, aspect: null, reason: null,
};

function projectWithClips() {
  const p = createEmptyProject({ id: 'p1', name: 'P' });
  p.tracks[1].clips.push({ id: 'c_img', kind: 'image', assetId: 'a_img', timelineStartUs: 2_000_000, durationUs: 1_000_000 } as never);
  p.tracks[0].clips.push({ id: 'c_vid', kind: 'video', assetId: 'a_vid', timelineStartUs: 500_000, durationUs: 1_000_000 } as never);
  return ProjectSchema.parse(p);
}

describe('plan target filtering', () => {
  it('drops ops with unknown clip/track ids and notes them', () => {
    const p = projectWithClips();
    const plan = parsePlan(
      JSON.stringify({
        summary: 's',
        operations: [
          { ...nullOp, text: 'Hello', startSec: 0, durationSec: 3 },
          { ...nullOp, type: 'deleteClip', clipId: 'c_missing' },
          { ...nullOp, type: 'setVolume', trackId: 'zz', volume: 0.5 },
          { ...nullOp, type: 'setVolume', trackId: 'a1', volume: 0.5 },
          { ...nullOp, type: 'deleteClip', clipId: 'c_img' },
        ],
        unsupported: [],
      }),
    );
    const out = filterPlanTargets(plan, p);
    expect(out.operations.map((o) => o.type)).toEqual(['addText', 'setVolume', 'deleteClip']);
    expect(out.unsupported).toHaveLength(2);
    expect(out.unsupported[0]).toContain('c_missing');
  });
  it('rejects invalid plans', () => {
    expect(() => parsePlan('{"summary":"x","operations":[{"type":"rm -rf"}],"unsupported":[]}')).toThrow();
    expect(() => parsePlan('not json')).toThrow();
  });
});

describe('transcription mapping', () => {
  it('adds offset to all timestamps', () => {
    const r = mapTranscription(
      { text: 'hi there', language: 'english', duration: 2, segments: [{ start: 0, end: 1.5, text: ' hi there ' }], words: [{ start: 0.1, end: 0.4, word: 'hi' }] },
      10,
      null,
    );
    expect(r.segments).toEqual([{ startSec: 10, endSec: 11.5, text: 'hi there' }]);
    expect(r.words).toEqual([{ startSec: 10.1, endSec: 10.4, word: 'hi' }]);
    expect(r.durationSec).toBe(2);
  });
  it('falls back to one segment for json-only models', () => {
    const r = mapTranscription({ text: 'hello' }, 1, 4);
    expect(r.segments).toEqual([{ startSec: 1, endSec: 5, text: 'hello' }]);
  });
});

describe('project helpers', () => {
  it('thumbnail is the earliest visual media clip', () => {
    expect(thumbnailAssetId(projectWithClips())).toBe('a_vid');
    expect(thumbnailAssetId(createEmptyProject({ id: 'x', name: 'x' }))).toBeNull();
  });
  it('revision snapshot policy', () => {
    const now = 1_000_000_000;
    expect(shouldSnapshot(null, 2, now)).toBe(true);
    expect(shouldSnapshot({ version: 5, created_at: now - 1000 }, 6, now)).toBe(false);
    expect(shouldSnapshot({ version: 5, created_at: now - REVISION_MIN_INTERVAL_MS }, 6, now)).toBe(true);
    expect(shouldSnapshot({ version: 5, created_at: now - 1000 }, 25, now)).toBe(true);
  });
});

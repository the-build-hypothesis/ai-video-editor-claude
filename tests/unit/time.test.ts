import { describe, it, expect } from 'vitest';
import { frameToUs, usToFrame, snapToFrame, frameCount, secToUs, usToSec, formatTimecode, clamp } from '../../src/shared/time';

const FPS = [24, 25, 30, 50, 60] as const;

describe('frameToUs', () => {
  it('returns exact integer microseconds for known frame rates', () => {
    expect(frameToUs(0, 30)).toBe(0);
    expect(frameToUs(1, 30)).toBe(33_333);
    expect(frameToUs(2, 30)).toBe(66_667);
    expect(frameToUs(30, 30)).toBe(1_000_000);
    expect(frameToUs(1, 24)).toBe(41_667);
    expect(frameToUs(24, 24)).toBe(1_000_000);
    expect(frameToUs(1, 25)).toBe(40_000);
    expect(frameToUs(1, 60)).toBe(16_667);
    expect(frameToUs(3600 * 60, 60)).toBe(3_600_000_000);
  });

  it.each(FPS)('is strictly increasing and always an integer at %i fps', (fps) => {
    let prev = -1;
    for (let n = 0; n < 5000; n++) {
      const t = frameToUs(n, fps);
      expect(Number.isInteger(t)).toBe(true);
      expect(t).toBeGreaterThan(prev);
      prev = t;
    }
  });

  it.each(FPS)('never deviates from the exact rational time by more than 0.5µs at %i fps', (fps) => {
    for (let n = 0; n < 200_000; n += 997) {
      expect(Math.abs(frameToUs(n, fps) - (n * 1e6) / fps)).toBeLessThanOrEqual(0.5);
    }
  });
});

describe('usToFrame', () => {
  it.each(FPS)('round-trips frameToUs exactly at %i fps (frame n starts at frameToUs(n))', (fps) => {
    for (let n = 0; n < 20_000; n++) {
      expect(usToFrame(frameToUs(n, fps), fps)).toBe(n);
    }
  });

  it.each(FPS)('maps the last microsecond of a frame to that frame at %i fps', (fps) => {
    for (let n = 0; n < 5000; n++) {
      expect(usToFrame(frameToUs(n + 1, fps) - 1, fps)).toBe(n);
    }
  });

  it('maps interior times to the containing frame', () => {
    expect(usToFrame(0, 30)).toBe(0);
    expect(usToFrame(10_000, 30)).toBe(0);
    expect(usToFrame(50_000, 30)).toBe(1);
    expect(usToFrame(999_999, 30)).toBe(29);
    expect(usToFrame(1_000_000, 30)).toBe(30);
    expect(usToFrame(39_999, 25)).toBe(0);
    expect(usToFrame(40_000, 25)).toBe(1);
  });
});

describe('snapToFrame', () => {
  it.each(FPS)('returns a frame boundary and is idempotent at %i fps', (fps) => {
    for (let t = 0; t < 3_000_000; t += 7_919) {
      const s = snapToFrame(t, fps);
      expect(Number.isInteger(s)).toBe(true);
      expect(frameToUs(usToFrame(s, fps), fps)).toBe(s);
      expect(snapToFrame(s, fps)).toBe(s);
      // Nearest boundary: within half a frame (+ rounding slack).
      expect(Math.abs(s - t)).toBeLessThanOrEqual(1e6 / fps / 2 + 1);
    }
  });

  it('snaps to the nearest, not the previous, boundary', () => {
    expect(snapToFrame(20_000, 30)).toBe(33_333);
    expect(snapToFrame(16_000, 30)).toBe(0);
    expect(snapToFrame(1_010_000, 25)).toBe(1_000_000);
  });

  it.each(FPS)('does not drift after many accumulated snapped edits at %i fps', (fps) => {
    // Simulate a clip dragged by snapped deltas many times; re-snapping the accumulated position
    // must always land exactly on the expected frame boundary.
    let t = 0;
    let frames = 0;
    let seed = 12345;
    for (let i = 0; i < 10_000; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const deltaFrames = (seed % 21) - 8; // -8..12, biased forward
      if (frames + deltaFrames < 0) continue;
      frames += deltaFrames;
      t = snapToFrame(t + snapToFrame(frameToUs(Math.abs(deltaFrames), fps) * Math.sign(deltaFrames), fps), fps);
      expect(t).toBe(frameToUs(frames, fps));
    }
    expect(frames).toBeGreaterThan(1000);
  });
});

describe('frameCount', () => {
  it('counts frames for whole-second durations', () => {
    expect(frameCount(30_000_000, 30)).toBe(900);
    expect(frameCount(10_000_000, 24)).toBe(240);
    expect(frameCount(10_000_000, 25)).toBe(250);
    expect(frameCount(1_000_000, 60)).toBe(60);
    expect(frameCount(0, 30)).toBe(0);
  });

  it('rounds partial frames up', () => {
    expect(frameCount(1, 30)).toBe(1);
    expect(frameCount(1_000_001, 30)).toBe(31);
  });

  it.each(FPS)('equals n for a duration that ends exactly at frame boundary n at %i fps', (fps) => {
    // Frame k is rendered iff frameToUs(k) < duration, so a frame-aligned duration needs exactly n frames.
    for (let n = 0; n < 10_000; n++) {
      expect(frameCount(frameToUs(n, fps), fps)).toBe(n);
    }
  });

  it.each(FPS)('counts exactly the frames whose sample time lies inside [0, d) at %i fps', (fps) => {
    for (let d = 1; d < 2_000_000; d += 4_999) {
      const n = frameCount(d, fps);
      expect(frameToUs(n - 1, fps)).toBeLessThan(d);
      expect(frameToUs(n, fps)).toBeGreaterThanOrEqual(d);
    }
  });
});

describe('misc helpers', () => {
  it('secToUs/usToSec convert and round', () => {
    expect(secToUs(1.5)).toBe(1_500_000);
    expect(secToUs(0.0000004)).toBe(0);
    expect(secToUs(1 / 3)).toBe(333_333);
    expect(usToSec(2_500_000)).toBe(2.5);
  });

  it('formatTimecode shows mm:ss:ff', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00');
    expect(formatTimecode(frameToUs(31, 30), 30)).toBe('00:01:01');
    expect(formatTimecode(61_000_000 + frameToUs(12, 24), 24)).toBe('01:01:12');
    expect(formatTimecode(-5, 30)).toBe('00:00:00');
  });

  it('clamp', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
});

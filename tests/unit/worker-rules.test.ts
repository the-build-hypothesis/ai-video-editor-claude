import { describe, it, expect } from 'vitest';
import { canTransition, isTerminal, windowStart, retryAfterSeconds, isOverLimit, parseAdminRange, isAdminEmail, parseRange, sanitizeFilename } from '../../src/worker/lib/rules';
import { estimateTokenCost, estimateAudioCost, baseModel } from '../../src/worker/lib/pricing';
import type { JobStatus } from '../../src/shared/api-types';

describe('export status transitions', () => {
  const all: JobStatus[] = ['queued', 'running', 'completed', 'failed', 'canceled'];
  it('allows the happy path', () => {
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('running', 'running')).toBe(true);
    expect(canTransition('running', 'completed')).toBe(true);
    expect(canTransition('running', 'failed')).toBe(true);
    expect(canTransition('running', 'canceled')).toBe(true);
    expect(canTransition('queued', 'canceled')).toBe(true);
  });
  it('rejects completing without running and leaving terminal states', () => {
    expect(canTransition('queued', 'completed')).toBe(false);
    for (const from of ['completed', 'failed', 'canceled'] as JobStatus[]) {
      expect(isTerminal(from)).toBe(true);
      for (const to of all) expect(canTransition(from, to)).toBe(false);
    }
    expect(canTransition('running', 'queued')).toBe(false);
  });
});

describe('rate-limit windows', () => {
  it('computes fixed windows', () => {
    expect(windowStart(1_000_000, 60_000)).toBe(960_000);
    expect(windowStart(960_000, 60_000)).toBe(960_000);
    expect(retryAfterSeconds(960_000, 60_000)).toBe(60);
    expect(retryAfterSeconds(1_019_500, 60_000)).toBe(1);
    expect(isOverLimit(10, 10)).toBe(false);
    expect(isOverLimit(11, 10)).toBe(true);
  });
});

describe('admin', () => {
  it('parses ranges', () => {
    const now = 10 * 86_400_000;
    expect(parseAdminRange('1h', now)).toEqual({ range: '1h', sinceMs: now - 3_600_000 });
    expect(parseAdminRange('7d', now)?.sinceMs).toBe(now - 7 * 86_400_000);
    expect(parseAdminRange(undefined, now)?.range).toBe('24h');
    expect(parseAdminRange('2w', now)).toBeNull();
    expect(parseAdminRange('constructor', now)).toBeNull();
  });
  it('matches admin emails', () => {
    expect(isAdminEmail('Admin@FrameForge.test', false, 'x@y.z, admin@frameforge.test')).toBe(true);
    expect(isAdminEmail('admin@frameforge.test', true, 'admin@frameforge.test')).toBe(false);
    expect(isAdminEmail(null, false, 'admin@frameforge.test')).toBe(false);
    expect(isAdminEmail('a@b.c', false, undefined)).toBe(false);
    expect(isAdminEmail('a@b.c', false, '')).toBe(false);
  });
});

describe('cost estimation', () => {
  it('prices tokens and audio', () => {
    expect(estimateTokenCost('gpt-4o-mini', 1_000_000, 1_000_000)).toBeCloseTo(0.75, 6);
    expect(estimateTokenCost('gpt-4o', 1000, 500)).toBeCloseTo(0.0075, 6);
    expect(estimateTokenCost('gpt-4o-mini-2024-07-18', 2000, 100)).toBeCloseTo(0.00036, 6);
    expect(estimateTokenCost('mystery-model', 10, 10)).toBeNull();
    expect(estimateTokenCost('gpt-4o-mini', null, 10)).toBeNull();
    expect(estimateAudioCost('whisper-1', 90)).toBeCloseTo(0.009, 6);
    expect(estimateAudioCost('gpt-4o-mini-transcribe', 60)).toBeCloseTo(0.003, 6);
    expect(estimateAudioCost('gpt-4o-transcribe', 30)).toBeCloseTo(0.003, 6);
    expect(estimateAudioCost('unknown', 60)).toBeNull();
    expect(estimateAudioCost('whisper-1', null)).toBeNull();
    expect(baseModel(' GPT-4o-2024-08-06 ')).toBe('gpt-4o');
  });
});

describe('HTTP range parsing', () => {
  it('parses single ranges', () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-1000', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=50-1000', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
    expect(parseRange('bytes=9-2', 100)).toBeNull();
  });
  it('sanitizes filenames', () => {
    expect(sanitizeFilename('My "Film": part/1', 'mp4')).toBe('My _Film_ part_1.mp4');
    expect(sanitizeFilename('../../etc/passwd', 'mp4')).toBe('_.._etc_passwd.mp4');
    expect(sanitizeFilename('Café ☕', 'mp4')).toBe('Cafe.mp4');
    expect(sanitizeFilename('', 'mp4')).toBe('export.mp4');
  });
});

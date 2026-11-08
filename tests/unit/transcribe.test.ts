import { describe, it, expect, vi } from 'vitest';
vi.mock('../../src/client/api', () => ({ api: {}, ApiError: class extends Error {} }));
vi.mock('../../src/client/engine/media-cache', () => ({ mediaCache: {} }));
vi.mock('../../src/client/engine/probe', () => ({ encodeWavSegment: vi.fn() }));
const { chunkWords, punctuateWords, toSrt } = await import('../../src/client/transcribe');

const w = (word: string, s: number) => ({ word, startSec: s, endSec: s + 0.3 });

describe('caption chunking', () => {
  it('restores punctuation from segments and breaks after sentence ends', () => {
    const words = [w('welcome', 0), w('to', 0.3), w('the', 0.6), w('demo', 0.9), w('thanks', 1.5), w('for', 1.8), w('watching', 2.1)];
    const segs = [{ startSec: 0, endSec: 1.2, text: ' Welcome to the demo.' }, { startSec: 1.5, endSec: 2.4, text: ' Thanks for watching!' }];
    const p = punctuateWords(words, segs);
    expect(p.map((x) => x.word)).toEqual(['Welcome', 'to', 'the', 'demo.', 'Thanks', 'for', 'watching!']);
    const chunks = chunkWords(p);
    expect(chunks.map((c) => c.text)).toEqual(['Welcome to the demo.', 'Thanks for watching!']);
    expect(chunks[0].startSec).toBe(0);
    expect(chunks[1].endSec).toBeCloseTo(2.4);
  });
  it('splits long runs by character count and duration', () => {
    const words = Array.from({ length: 30 }, (_, i) => w('word' + i, i * 0.2));
    for (const c of chunkWords(words)) {
      expect(c.text.length).toBeLessThanOrEqual(48);
      expect(c.endSec - c.startSec).toBeLessThanOrEqual(3.8);
    }
  });
  it('tolerates mismatches and formats SRT', () => {
    expect(punctuateWords([w('hello', 0)], [{ startSec: 0, endSec: 1, text: 'Goodbye.' }])[0].word).toBe('hello');
    expect(toSrt([{ id: 'a', startUs: 1_500_000, endUs: 3_000_000, text: 'Hi' }])).toBe('1\n00:00:01,500 --> 00:00:03,000\nHi\n');
  });
});

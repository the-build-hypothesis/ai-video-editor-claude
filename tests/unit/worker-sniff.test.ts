import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sniffType, matchesMime } from '../../src/worker/lib/sniff';
import { wavDurationSec } from '../../src/worker/lib/plan';

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`../../fixtures/${n}`, import.meta.url))).subarray(0, 64);
const bytes = (...a: (number | string)[]) => new Uint8Array(a.flatMap((x) => (typeof x === 'string' ? [...x].map((ch) => ch.charCodeAt(0)) : [x])));

describe('magic-byte sniffing', () => {
  it('detects fixtures', () => {
    expect(sniffType(fx('clip-c-portrait.mp4'))).toBe('mp4');
    expect(sniffType(fx('logo.png'))).toBe('png');
    expect(sniffType(fx('music.mp3'))).toBe('mp3');
    expect(sniffType(fx('corrupt.mp4'))).not.toBe('mp4');
    expect(matchesMime(fx('corrupt.mp4'), 'video/mp4')).toBe(false);
  });
  it('detects synthetic headers', () => {
    expect(sniffType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
    expect(sniffType(bytes('RIFF', 0, 0, 0, 0, 'WAVE'))).toBe('wav');
    expect(sniffType(bytes('RIFF', 0, 0, 0, 0, 'WEBP'))).toBe('webp');
    expect(sniffType(bytes('ID3', 4, 0))).toBe('mp3');
    expect(sniffType(bytes(0xff, 0xfb, 0x90, 0x00))).toBe('mp3');
    expect(sniffType(bytes(0xff, 0x1b))).toBe(null);
    expect(sniffType(bytes(0, 0, 0, 0x20, 'ftypisom'))).toBe('mp4');
    expect(sniffType(new Uint8Array(0))).toBe(null);
  });
  it('checks declared MIME', () => {
    const png = fx('logo.png');
    expect(matchesMime(png, 'image/png')).toBe(true);
    expect(matchesMime(png, 'IMAGE/PNG')).toBe(true);
    expect(matchesMime(png, 'image/jpeg')).toBe(false);
    expect(matchesMime(png, 'text/html')).toBe(false);
    expect(matchesMime(bytes('RIFF', 0, 0, 0, 0, 'WAVE'), 'audio/x-wav')).toBe(true);
    expect(matchesMime(fx('music.mp3'), 'audio/mpeg')).toBe(true);
  });
  it('reads WAV duration from header', () => {
    const h = new Uint8Array(44);
    const dv = new DataView(h.buffer);
    h.set(bytes('RIFF'), 0); h.set(bytes('WAVE'), 8); h.set(bytes('fmt '), 12);
    dv.setUint32(16, 16, true); dv.setUint32(28, 32000, true); // 16 kHz mono 16-bit
    h.set(bytes('data'), 36); dv.setUint32(40, 32000 * 5, true);
    expect(wavDurationSec(h)).toBe(5);
    expect(wavDurationSec(fx('logo.png'))).toBe(null);
  });
});

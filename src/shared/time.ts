import { US } from './model';

/** Timestamp (µs) of frame n at the given fps. Frame n covers [frameToUs(n), frameToUs(n+1)). */
export function frameToUs(n: number, fps: number): number {
  return Math.round((n * US) / fps);
}

/** Index of the frame that contains time t (µs). */
export function usToFrame(t: number, fps: number): number {
  // frameToUs rounds to whole µs, so a boundary may sit up to 0.5µs before the exact rational
  // time. Start from the exact estimate and correct by one against the rounded boundaries so that
  // usToFrame(frameToUs(n)) === n for every fps.
  let n = Math.floor((t * fps) / US);
  if (frameToUs(n + 1, fps) <= t) n++;
  else if (frameToUs(n, fps) > t) n--;
  return n;
}

/** Snap a time to the nearest frame boundary. */
export function snapToFrame(t: number, fps: number): number {
  return frameToUs(Math.round((t * fps) / US), fps);
}

/** Number of frames needed to render [0, durationUs). */
export function frameCount(durationUs: number, fps: number): number {
  if (durationUs <= 0) return 0;
  // Frame n is rendered iff frameToUs(n) < durationUs, i.e. count = 1 + index of the last such frame.
  return usToFrame(durationUs - 1, fps) + 1;
}

export function secToUs(s: number): number {
  return Math.round(s * US);
}
export function usToSec(t: number): number {
  return t / US;
}

/** mm:ss.ff (frames) timecode. */
export function formatTimecode(t: number, fps: number): string {
  const totalFrames = Math.max(0, Math.round((t * fps) / US));
  const f = totalFrames % fps;
  const totalSec = Math.floor(totalFrames / fps);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

/** m:ss.s short form for labels. */
export function formatShort(t: number): string {
  const sec = Math.max(0, t / US);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

import { US } from './model';

/** Timestamp (µs) of frame n at the given fps. Frame n covers [frameToUs(n), frameToUs(n+1)). */
export function frameToUs(n: number, fps: number): number {
  return Math.round((n * US) / fps);
}

/** Index of the frame that contains time t (µs). */
export function usToFrame(t: number, fps: number): number {
  // Small epsilon guards against values that are exactly on a rounded boundary.
  return Math.floor((t * fps + 0.5) / US);
}

/** Snap a time to the nearest frame boundary. */
export function snapToFrame(t: number, fps: number): number {
  return frameToUs(Math.round((t * fps) / US), fps);
}

/** Number of frames needed to render [0, durationUs). */
export function frameCount(durationUs: number, fps: number): number {
  return Math.ceil((durationUs * fps) / US - 1e-9);
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

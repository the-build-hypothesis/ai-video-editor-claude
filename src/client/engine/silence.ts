/**
 * Audio-energy silence detection for a clip (AI-09, transcript-free). Works on the decoded source
 * audio of the clip's used range and returns proposed TIMELINE ranges to cut, with padding kept
 * around speech so words are not clipped.
 */
import type { Clip } from '../../shared/model';
import { clipEndUs } from '../../shared/model';

export interface SilenceOptions {
  /** Level below the clip's loud reference (dB) that counts as silence. */
  thresholdDb: number;
  /** Minimum silence length to propose a cut (s). */
  minSilenceSec: number;
  /** Audio kept on each side of a cut (s). */
  paddingSec: number;
}

export const DEFAULT_SILENCE: SilenceOptions = { thresholdDb: -35, minSilenceSec: 0.6, paddingSec: 0.15 };

export function detectSilences(buf: AudioBuffer, clip: Extract<Clip, { kind: 'video' | 'audio' }>, opts: SilenceOptions = DEFAULT_SILENCE): { startUs: number; endUs: number }[] {
  const sr = buf.sampleRate;
  const win = Math.max(1, Math.round(sr * 0.02)); // 20 ms windows
  const srcStart = clip.sourceStartUs / 1e6;
  const srcEnd = Math.min(buf.duration, srcStart + (clip.durationUs * clip.speed) / 1e6);
  const s0 = Math.floor(srcStart * sr);
  const s1 = Math.floor(srcEnd * sr);
  const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  const rms: number[] = [];
  for (let i = s0; i < s1; i += win) {
    let sum = 0;
    const end = Math.min(s1, i + win);
    for (let j = i; j < end; j++) {
      let v = 0;
      for (const ch of chans) v += ch[j];
      v /= chans.length;
      sum += v * v;
    }
    rms.push(Math.sqrt(sum / Math.max(1, end - i)));
  }
  if (!rms.length) return [];
  // Reference: 95th percentile loudness of the clip (robust to spikes).
  const sorted = [...rms].sort((a, b) => a - b);
  const ref = Math.max(1e-4, sorted[Math.floor(sorted.length * 0.95)]);
  const thr = ref * Math.pow(10, opts.thresholdDb / 20);
  const out: { startUs: number; endUs: number }[] = [];
  const winSec = win / sr;
  let runStart = -1;
  const flush = (endIdx: number) => {
    const a = srcStart + runStart * winSec + opts.paddingSec;
    const b = srcStart + endIdx * winSec - opts.paddingSec;
    if (b - a >= opts.minSilenceSec - 2 * opts.paddingSec && b - a > 0.1) {
      const toTl = (srcSec: number) => Math.round(clip.timelineStartUs + ((srcSec - srcStart) * 1e6) / clip.speed);
      out.push({ startUs: Math.max(clip.timelineStartUs, toTl(a)), endUs: Math.min(clipEndUs(clip), toTl(b)) });
    }
  };
  for (let i = 0; i < rms.length; i++) {
    if (rms[i] < thr) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      if ((i - runStart) * winSec >= opts.minSilenceSec) flush(i);
      runStart = -1;
    }
  }
  if (runStart >= 0 && (rms.length - runStart) * winSec >= opts.minSilenceSec) flush(rms.length);
  return out.filter((r) => r.endUs > r.startUs);
}

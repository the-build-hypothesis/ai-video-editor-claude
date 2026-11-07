/**
 * Builds the Web Audio mix graph for a project. Used by live preview (AudioContext) and export
 * (OfflineAudioContext) with identical scheduling so the exported mix matches what you hear.
 *
 * Speed changes use AudioBufferSourceNode.playbackRate → pitch changes with speed (documented).
 */
import type { Project } from '../../shared/model';
import { segmentGainAt, type AudioSegment } from '../../shared/timeline-eval';

export interface MixHandle {
  sources: AudioBufferSourceNode[];
  output: GainNode;
  stop(): void;
}

/** Master chain: gain(masterVolume) → limiter (DynamicsCompressor) → destination. */
export function createMaster(ctx: BaseAudioContext, p: Project): { input: GainNode; limiter: DynamicsCompressorNode } {
  const input = ctx.createGain();
  input.gain.value = p.settings.masterVolume;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  input.connect(limiter);
  limiter.connect(ctx.destination);
  return { input, limiter };
}

/**
 * Schedule all segments that overlap [fromUs, toUs) to play so that timeline time `fromUs`
 * corresponds to context time `ctxStart`.
 */
export function scheduleSegments(
  ctx: BaseAudioContext,
  dest: AudioNode,
  segments: AudioSegment[],
  buffers: Map<string, AudioBuffer>,
  fromUs: number,
  ctxStart: number,
  toUs = Infinity,
): MixHandle {
  const sources: AudioBufferSourceNode[] = [];
  const output = ctx.createGain();
  output.connect(dest);
  for (const seg of segments) {
    const buf = buffers.get(seg.assetId);
    if (!buf) continue;
    const segEnd = seg.timelineStartUs + seg.durationUs;
    if (segEnd <= fromUs || seg.timelineStartUs >= toUs) continue;
    const offsetUs = Math.max(0, fromUs - seg.timelineStartUs); // timeline offset into clip
    const playUs = Math.min(segEnd, toUs) - Math.max(seg.timelineStartUs, fromUs);
    if (playUs <= 0) continue;
    const srcOffsetSec = (seg.sourceStartUs + offsetUs * seg.speed) / 1e6;
    if (srcOffsetSec >= buf.duration) continue;
    const when = ctxStart + Math.max(0, seg.timelineStartUs - fromUs) / 1e6;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = seg.speed;
    const g = ctx.createGain();
    // Gain envelope sampled at 100 Hz from the shared gain function (fades + automation).
    const startTl = Math.max(seg.timelineStartUs, fromUs);
    const durSec = playUs / 1e6;
    const n = Math.max(2, Math.min(20000, Math.ceil(durSec * 100) + 1));
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const tl = startTl + (playUs * i) / (n - 1);
      curve[i] = segmentGainAt(seg, Math.min(tl, segEnd - 1));
    }
    try {
      g.gain.setValueCurveAtTime(curve, Math.max(when, ctx.currentTime), durSec);
    } catch {
      g.gain.value = seg.gain;
    }
    src.connect(g);
    g.connect(output);
    // duration argument is in *buffer* seconds (affected by playbackRate).
    src.start(Math.max(when, ctx.currentTime), srcOffsetSec, durSec * seg.speed);
    sources.push(src);
  }
  return {
    sources,
    output,
    stop() {
      for (const s of sources) {
        try {
          s.stop();
        } catch {
          /* already stopped */
        }
        s.disconnect();
      }
      output.disconnect();
    },
  };
}

/** Render the full mix offline (export). */
export async function renderMixOffline(p: Project, segments: AudioSegment[], buffers: Map<string, AudioBuffer>, durationUs: number, sampleRate = 48000): Promise<AudioBuffer> {
  const length = Math.max(1, Math.ceil((durationUs / 1e6) * sampleRate));
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });
  const master = createMaster(ctx, p);
  scheduleSegments(ctx, master.input, segments, buffers, 0, 0, durationUs);
  return ctx.startRendering();
}

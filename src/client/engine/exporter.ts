/**
 * Browser-side MP4 exporter (EXP-01/02/06).
 *  - Frames: for each output frame n at t = round(n·1e6/fps), the shared compositor draws the
 *    timeline onto an OffscreenCanvas using exact frames decoded by WebCodecs (mediabunny sinks).
 *  - Video: H.264 (avc) via WebCodecs VideoEncoder.
 *  - Audio: the shared Web Audio mix graph rendered in an OfflineAudioContext, encoded to AAC via
 *    WebCodecs AudioEncoder, or the @mediabunny/aac-encoder WASM polyfill where the browser lacks
 *    a native AAC encoder (e.g. Chromium on Linux).
 *  - Mux: MP4 (ISO BMFF, faststart) via mediabunny.
 * If H.264 encoding is unavailable we FAIL with a clear message — we never relabel another codec.
 */
import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  VideoSampleSink,
  canEncodeAudio,
  canEncodeVideo,
  type VideoSample,
} from 'mediabunny';
import type { AssetIndex, Project, VideoClip } from '../../shared/model';
import { audioSegments, evaluateVisualLayers, type VisualLayer } from '../../shared/timeline-eval';
import { frameToUs, frameCount } from '../../shared/time';
import { projectDurationUs } from '../../shared/model';
import { renderFrame, type DrawableSource } from './compositor';
import { renderMixOffline } from './audio-graph';
import { mediaCache } from './media-cache';

export interface ExportSettings {
  /** Short side in pixels (720 / 1080). */
  shortSide: number;
  fps: number;
  videoBitrate: number;
  audioBitrate: number;
}

export interface ExportProgress {
  phase: 'preparing' | 'audio' | 'video' | 'finalizing';
  progress: number; // 0..1 overall
  frame?: number;
  frames?: number;
}

export class ExportCanceled extends Error {
  constructor() {
    super('Export canceled');
  }
}

export function outputSize(p: Project, shortSide: number) {
  const { width: W, height: H } = p.settings;
  const s = shortSide / Math.min(W, H);
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  return { width: even(W * s), height: even(H * s) };
}

/** Sequential frame reader: returns the last decoded frame with timestamp ≤ t. */
class FrameReader {
  private it: AsyncGenerator<VideoSample, void, unknown> | null = null;
  private cur: VideoSample | null = null;
  private nxt: VideoSample | null = null;
  private lastT = -1;
  private done = false;
  constructor(private sink: VideoSampleSink, private firstTs: number) {}

  private async restart(t: number) {
    await this.close();
    this.done = false;
    this.it = this.sink.samples(Math.max(this.firstTs, t));
    const a = await this.it.next();
    this.cur = a.done ? null : a.value;
    const b = a.done ? { done: true as const, value: undefined } : await this.it.next();
    this.nxt = b.done ? null : b.value;
    this.done = !!b.done;
  }

  async at(t: number): Promise<VideoSample | null> {
    if (!this.it || t < this.lastT - 1e-6 || (this.cur && t - this.cur.timestamp > 2.5)) await this.restart(t);
    this.lastT = t;
    while (this.nxt && this.nxt.timestamp <= t + 1e-4) {
      this.cur?.close();
      this.cur = this.nxt;
      if (this.done) {
        this.nxt = null;
        break;
      }
      const r = await this.it!.next();
      this.nxt = r.done ? null : r.value;
      if (r.done) this.done = true;
    }
    return this.cur;
  }

  async close() {
    this.cur?.close();
    this.nxt?.close();
    this.cur = this.nxt = null;
    if (this.it) await this.it.return(undefined).catch(() => {});
    this.it = null;
  }
}

let aacRegistered = false;
async function ensureAac(): Promise<'native' | 'wasm'> {
  if (await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000, bitrate: 128000 })) return 'native';
  if (!aacRegistered) {
    const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
    registerAacEncoder();
    aacRegistered = true;
  }
  return 'wasm';
}

export async function checkExportSupport(width = 1920, height = 1080): Promise<{ ok: boolean; reason?: string }> {
  if (typeof VideoEncoder === 'undefined' || typeof OffscreenCanvas === 'undefined')
    return { ok: false, reason: 'This browser lacks WebCodecs. Use a recent Chrome, Edge or Safari 17+ (desktop).' };
  const ok = await canEncodeVideo('avc', { width, height, bitrate: 4e6 });
  if (!ok) return { ok: false, reason: 'This browser cannot encode H.264 video via WebCodecs, so MP4 export is unavailable. Try Chrome or Edge on desktop.' };
  return { ok: true };
}

export async function exportMp4(
  project: Project,
  assets: AssetIndex,
  settings: ExportSettings,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
): Promise<{ blob: Blob; width: number; height: number; durationUs: number; frames: number; audioEncoder: string }> {
  const check = () => {
    if (signal.aborted) throw new ExportCanceled();
  };
  const { width, height } = outputSize(project, settings.shortSide);
  const support = await checkExportSupport(width, height);
  if (!support.ok) throw new Error(support.reason);
  const durationUs = projectDurationUs(project);
  if (durationUs <= 0) throw new Error('Timeline is empty — add clips before exporting.');
  const fps = settings.fps;
  const frames = frameCount(durationUs, fps);
  onProgress({ phase: 'preparing', progress: 0 });

  // --- Prepare sources
  const usedVideo = new Map<string, VideoClip[]>();
  const usedImages = new Set<string>();
  for (const t of project.tracks) {
    if (t.kind !== 'video' || t.hidden) continue;
    for (const c of t.clips) {
      if (c.kind === 'video') usedVideo.set(c.assetId, [...(usedVideo.get(c.assetId) ?? []), c]);
      if (c.kind === 'image') usedImages.add(c.assetId);
    }
  }
  const inputs: Input[] = [];
  const readers = new Map<string, FrameReader>(); // by clip id
  try {
    for (const [assetId, clips] of usedVideo) {
      const blob = await mediaCache.getBlob(assetId);
      check();
      for (const clip of clips) {
        // One input/sink per clip so each has an independent sequential decode cursor.
        const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
        inputs.push(input);
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw new Error(`Asset ${assets[assetId]?.name ?? assetId} has no video track`);
        if (!(await track.canDecode())) throw new Error(`This browser cannot decode ${assets[assetId]?.name ?? 'a source video'} (codec ${track.codec}).`);
        const firstTs = await track.getFirstTimestamp();
        readers.set(clip.id, new FrameReader(new VideoSampleSink(track), firstTs));
      }
    }
    for (const id of usedImages) await mediaCache.loadImage(id);
    check();

    // --- Output
    const audioEncoder = await ensureAac();
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { alpha: false })!;
    const videoSource = new CanvasSource(canvas, {
      codec: 'avc',
      bitrate: settings.videoBitrate,
      keyFrameInterval: 2,
      latencyMode: 'quality',
    });
    output.addVideoTrack(videoSource, { frameRate: fps });
    const segs = audioSegments(project, assets);
    const audioSource = new AudioBufferSource({ codec: 'aac', bitrate: settings.audioBitrate });
    output.addAudioTrack(audioSource);
    await output.start();

    // --- Audio (always present; silent if the timeline has no audio so players behave consistently)
    onProgress({ phase: 'audio', progress: 0.02 });
    const buffers = new Map<string, AudioBuffer>();
    for (const s of segs) {
      const b = await mediaCache.loadAudio(s.assetId);
      if (b) buffers.set(s.assetId, b);
      check();
    }
    const mix = await renderMixOffline(project, segs, buffers, frameToUs(frames, fps), 48000);
    check();
    await audioSource.add(mix);
    audioSource.close();
    onProgress({ phase: 'audio', progress: 0.08 });

    // --- Video frames
    const frameSources = new Map<string, DrawableSource>();
    // Rotation/flip metadata (e.g. phone footage): draw into an upright canvas first so the
    // compositor sees the same orientation as the <video>-based preview.
    const uprightCanvases = new Map<string, OffscreenCanvas>();
    const uprightSource = (clipId: string, sample: VideoSample): DrawableSource => {
      const dw = sample.displayWidth;
      const dh = sample.displayHeight;
      if (!sample.rotation && !(sample as { flipped?: boolean }).flipped) return { image: sample.toCanvasImageSource(), width: dw, height: dh };
      let c = uprightCanvases.get(clipId);
      if (!c || c.width !== dw || c.height !== dh) {
        c = new OffscreenCanvas(dw, dh);
        uprightCanvases.set(clipId, c);
      }
      const cx = c.getContext('2d')!;
      cx.clearRect(0, 0, dw, dh);
      sample.draw(cx, 0, 0, dw, dh);
      return { image: c, width: dw, height: dh };
    };
    const resolve = (layer: VisualLayer): DrawableSource | null => {
      if (layer.clip.kind === 'image') {
        const img = mediaCache.image(layer.clip.assetId);
        return img ? { image: img, width: img.width, height: img.height } : null;
      }
      return frameSources.get(layer.clip.id) ?? null;
    };
    const scale = width / project.settings.width;
    for (let n = 0; n < frames; n++) {
      check();
      const t = frameToUs(n, fps);
      const layers = evaluateVisualLayers(project, t);
      frameSources.clear();
      for (const l of layers) {
        if (l.clip.kind !== 'video') continue;
        const r = readers.get(l.clip.id);
        if (!r) continue;
        const sample = await r.at(Math.max(0, l.sourceUs / 1e6));
        if (sample) frameSources.set(l.clip.id, uprightSource(l.clip.id, sample));
      }
      renderFrame(ctx, project, t, resolve, { scale, captions: project.captions.burnIn });
      await videoSource.add(t / 1e6, (frameToUs(n + 1, fps) - t) / 1e6);
      if (n % 5 === 0) onProgress({ phase: 'video', progress: 0.08 + 0.9 * (n / frames), frame: n, frames });
    }
    videoSource.close();
    onProgress({ phase: 'finalizing', progress: 0.99 });
    await output.finalize();
    const blob = new Blob([target.buffer!], { type: 'video/mp4' });
    onProgress({ phase: 'finalizing', progress: 1 });
    return { blob, width, height, durationUs: frameToUs(frames, fps), frames, audioEncoder };
  } finally {
    for (const r of readers.values()) await r.close();
    for (const i of inputs) i.dispose?.();
  }
}

/**
 * Local media probing before upload (MEDIA-02/04/06): validates type & size, reads duration /
 * dimensions / audio presence, verifies the browser can decode it, and generates a thumbnail and
 * waveform peaks. Corrupt or unsupported files are rejected here (and again server-side by magic bytes).
 */
import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny';
import { ALLOWED_MIME, LIMITS, type AssetKind, type AssetMetadata } from '../../shared/api-types';
import { mediaCache } from './media-cache';

export interface ProbeResult {
  kind: AssetKind;
  mimeType: string;
  metadata: AssetMetadata;
  thumbnail: Blob | null;
  audio: AudioBuffer | null;
}

export class ProbeError extends Error {}

const EXT_MIME: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', mp3: 'audio/mpeg', wav: 'audio/wav' };

export function detectMime(file: File): string | null {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const byType = file.type && ALLOWED_MIME[file.type] ? file.type : null;
  const mime = byType ?? EXT_MIME[ext] ?? null;
  if (mime === 'audio/mp3') return 'audio/mpeg';
  if (mime === 'audio/x-wav' || mime === 'audio/wave') return 'audio/wav';
  return mime;
}

export function computePeaks(buf: AudioBuffer, count = 1000): number[] {
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const n = Math.min(count, Math.max(1, Math.floor(buf.length / 64)));
  const step = buf.length / n;
  const peaks: number[] = new Array(n);
  let max = 0;
  for (let i = 0; i < n; i++) {
    const s = Math.floor(i * step);
    const e = Math.min(buf.length, Math.floor((i + 1) * step));
    let m = 0;
    for (let j = s; j < e; j += 4) {
      const v = Math.abs(ch0[j]) + (ch1 ? Math.abs(ch1[j]) : 0);
      if (v > m) m = v;
    }
    peaks[i] = ch1 ? m / 2 : m;
    if (peaks[i] > max) max = peaks[i];
  }
  return peaks.map((v) => Math.round((max > 0 ? Math.min(1, v / Math.max(max, 0.05)) : 0) * 1000) / 1000);
}

async function canvasToJpeg(source: CanvasImageSource, sw: number, sh: number): Promise<Blob> {
  const w = 320;
  const h = Math.max(2, Math.round((sh / sw) * w));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(source, 0, 0, w, h);
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
}

export async function probeFile(file: File): Promise<ProbeResult> {
  const mime = detectMime(file);
  if (!mime) throw new ProbeError(`Unsupported file type for "${file.name}". Supported: MP4 video, PNG/JPEG images, MP3/WAV audio.`);
  const kind = ALLOWED_MIME[mime];
  if (file.size > LIMITS.maxAssetBytes) throw new ProbeError(`"${file.name}" is ${(file.size / 1048576).toFixed(0)} MB; the limit is ${LIMITS.maxAssetBytes / 1048576} MB per file.`);
  if (file.size === 0) throw new ProbeError(`"${file.name}" is empty.`);

  if (kind === 'image') {
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(file);
    } catch {
      throw new ProbeError(`"${file.name}" could not be decoded as an image — it may be corrupt.`);
    }
    const thumbnail = await canvasToJpeg(bmp, bmp.width, bmp.height);
    const meta: AssetMetadata = { durationUs: null, width: bmp.width, height: bmp.height, hasAudio: false, hasThumbnail: true };
    bmp.close();
    return { kind, mimeType: mime, metadata: meta, thumbnail, audio: null };
  }

  if (kind === 'audio') {
    const audio = await mediaCache.decodeFileAudio(file);
    if (!audio) throw new ProbeError(`"${file.name}" could not be decoded as audio — it may be corrupt or use an unsupported codec.`);
    if (audio.duration > LIMITS.maxMediaDurationSec) throw new ProbeError(`Audio longer than ${LIMITS.maxMediaDurationSec / 60} minutes is not supported.`);
    return {
      kind,
      mimeType: mime,
      metadata: { durationUs: Math.round(audio.duration * 1e6), width: null, height: null, hasAudio: true, peaks: computePeaks(audio) },
      thumbnail: null,
      audio,
    };
  }

  // video
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    let vt;
    try {
      vt = await input.getPrimaryVideoTrack();
    } catch {
      throw new ProbeError(`"${file.name}" is not a readable MP4 — it may be corrupt or truncated.`);
    }
    if (!vt) throw new ProbeError(`"${file.name}" has no video track.`);
    if (!(await vt.canDecode())) throw new ProbeError(`This browser cannot decode the video codec (${vt.codec ?? 'unknown'}) in "${file.name}". Use H.264 MP4.`);
    const durationSec = await input.computeDuration();
    if (!(durationSec > 0)) throw new ProbeError(`"${file.name}" has no playable duration.`);
    if (durationSec > LIMITS.maxMediaDurationSec) throw new ProbeError(`Video longer than ${LIMITS.maxMediaDurationSec / 60} minutes is not supported.`);
    const at = await input.getPrimaryAudioTrack();
    let fps: number | null = null;
    try {
      const stats = await vt.computePacketStats(120);
      fps = Math.round(stats.averagePacketRate * 100) / 100;
    } catch {
      fps = null;
    }
    let thumbnail: Blob | null = null;
    try {
      const sink = new VideoSampleSink(vt);
      const sample = await sink.getSample(Math.min(1, durationSec / 3));
      if (sample) {
        // draw() honours rotation/flip metadata so thumbnails match the preview orientation.
        const tw = 320;
        const th = Math.max(2, Math.round((sample.displayHeight / sample.displayWidth) * tw));
        const tc = new OffscreenCanvas(tw, th);
        sample.draw(tc.getContext('2d')!, 0, 0, tw, th);
        thumbnail = await tc.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
        sample.close();
      }
    } catch {
      throw new ProbeError(`"${file.name}" could not be decoded — it may be corrupt.`);
    }
    let audio: AudioBuffer | null = null;
    let peaks: number[] | undefined;
    if (at) {
      audio = await mediaCache.decodeFileAudio(file);
      if (audio) peaks = computePeaks(audio);
    }
    return {
      kind,
      mimeType: mime,
      metadata: {
        durationUs: Math.round(durationSec * 1e6),
        width: vt.displayWidth,
        height: vt.displayHeight,
        hasAudio: !!audio,
        peaks,
        hasThumbnail: !!thumbnail,
        fps,
      },
      thumbnail,
      audio,
    };
  } finally {
    input.dispose?.();
  }
}

/** Encode a mono 16 kHz WAV of [startSec, endSec) of an AudioBuffer (for transcription upload). */
export async function encodeWavSegment(buf: AudioBuffer, startSec: number, endSec: number, rate = 16000): Promise<Blob> {
  const dur = Math.max(0.1, Math.min(buf.duration, endSec) - startSec);
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: Math.ceil(dur * rate), sampleRate: rate });
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0, startSec, dur);
  const out = await ctx.startRendering();
  const data = out.getChannelData(0);
  const bytes = new ArrayBuffer(44 + data.length * 2);
  const v = new DataView(bytes);
  const w = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + data.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

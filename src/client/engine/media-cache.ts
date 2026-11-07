/**
 * Client-side media cache: original blobs (fetched once from the authenticated asset endpoint),
 * decoded AudioBuffers (for preview mix + export), and ImageBitmaps for image clips.
 */
import { assetContentUrl } from '../api';

type Listener = () => void;

class MediaCache {
  private blobs = new Map<string, Promise<Blob>>();
  private audio = new Map<string, Promise<AudioBuffer | null>>();
  private audioReady = new Map<string, AudioBuffer | null>();
  private images = new Map<string, ImageBitmap>();
  private imageLoading = new Set<string>();
  private listeners = new Set<Listener>();
  private decodeCtx: AudioContext | null = null;

  onChange(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private emit() {
    for (const l of this.listeners) l();
  }

  putBlob(assetId: string, blob: Blob) {
    this.blobs.set(assetId, Promise.resolve(blob));
  }

  getBlob(assetId: string): Promise<Blob> {
    let p = this.blobs.get(assetId);
    if (!p) {
      p = fetch(assetContentUrl(assetId), { credentials: 'same-origin' }).then(async (r) => {
        if (!r.ok) throw new Error(`Failed to load media (${r.status})`);
        return r.blob();
      });
      p.catch(() => this.blobs.delete(assetId));
      this.blobs.set(assetId, p);
    }
    return p;
  }

  private ctx(): AudioContext {
    if (!this.decodeCtx) this.decodeCtx = new AudioContext({ sampleRate: 48000 });
    return this.decodeCtx;
  }

  /** Decoded audio (null if the asset has no decodable audio). */
  loadAudio(assetId: string): Promise<AudioBuffer | null> {
    let p = this.audio.get(assetId);
    if (!p) {
      p = this.getBlob(assetId)
        .then((b) => b.arrayBuffer())
        .then((ab) => this.ctx().decodeAudioData(ab))
        .catch(() => null)
        .then((buf) => {
          this.audioReady.set(assetId, buf);
          this.emit();
          return buf;
        });
      this.audio.set(assetId, p);
    }
    return p;
  }

  audioIfReady(assetId: string): AudioBuffer | null | undefined {
    return this.audioReady.get(assetId);
  }

  async decodeFileAudio(file: Blob): Promise<AudioBuffer | null> {
    try {
      return await this.ctx().decodeAudioData(await file.arrayBuffer());
    } catch {
      return null;
    }
  }

  image(assetId: string): ImageBitmap | null {
    const img = this.images.get(assetId);
    if (img) return img;
    if (!this.imageLoading.has(assetId)) {
      this.imageLoading.add(assetId);
      this.loadImage(assetId)
        .then(() => this.emit())
        .catch(() => this.imageLoading.delete(assetId));
    }
    return null;
  }

  async loadImage(assetId: string): Promise<ImageBitmap> {
    const existing = this.images.get(assetId);
    if (existing) return existing;
    const blob = await this.getBlob(assetId);
    const bmp = await createImageBitmap(blob);
    this.images.set(assetId, bmp);
    return bmp;
  }

  async objectUrl(assetId: string): Promise<string> {
    return URL.createObjectURL(await this.getBlob(assetId));
  }
}

export const mediaCache = new MediaCache();

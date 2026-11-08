/**
 * Live preview engine. Composes the full timeline (all tracks, titles, captions) onto a canvas using
 * the shared compositor. Master clock during playback = AudioContext.currentTime; audio is mixed with
 * the same graph as export. Video frames come from one HTMLVideoElement per visible clip, kept in
 * sync with the clock (re-seek if drift > 120 ms).
 */
import type { AssetIndex, Project } from '../../shared/model';
import { audioSegments, evaluateVisualLayers, type VisualLayer } from '../../shared/timeline-eval';
import { projectDurationUs } from '../../shared/model';
import { renderFrame, type DrawableSource } from './compositor';
import { createMaster, scheduleSegments, type MixHandle } from './audio-graph';
import { mediaCache } from './media-cache';
import { assetContentUrl } from '../api';

interface VideoSlot {
  el: HTMLVideoElement;
  assetId: string;
  lastUsed: number;
  seeking: boolean;
  pendingSeek: number | null;
}

export interface PreviewOptions {
  quality: number; // 1, 0.5, 0.25
  guides: boolean;
  selectedClipIds: string[];
}

export class PreviewEngine {
  private ctx2d: CanvasRenderingContext2D;
  private project: Project | null = null;
  private assets: AssetIndex = {};
  private slots = new Map<string, VideoSlot>();
  private audioCtx: AudioContext | null = null;
  private mix: MixHandle | null = null;
  private master: ReturnType<typeof createMaster> | null = null;
  private raf = 0;
  private playStartUs = 0;
  private ctxStart = 0;
  private drawPending = false;
  private loadingShown = false;
  private disposeCache: () => void;
  timeUs = 0;
  playing = false;
  opts: PreviewOptions = { quality: 0.5, guides: false, selectedClipIds: [] };
  onTime: (t: number) => void = () => {};
  onEnded: () => void = () => {};
  onStatus: (s: string | null) => void = () => {};

  constructor(private canvas: HTMLCanvasElement, private container: HTMLElement) {
    this.ctx2d = canvas.getContext('2d', { alpha: false })!;
    this.disposeCache = mediaCache.onChange(() => this.requestDraw());
  }

  dispose() {
    this.pause();
    cancelAnimationFrame(this.raf);
    for (const s of this.slots.values()) {
      s.el.pause();
      s.el.removeAttribute('src');
      s.el.load();
      s.el.remove();
    }
    this.slots.clear();
    this.disposeCache();
    void this.audioCtx?.close();
  }

  setProject(p: Project, assets: AssetIndex) {
    const structural = this.project !== p;
    this.project = p;
    this.assets = assets;
    this.resize();
    // Preload audio for all audio-bearing assets.
    for (const seg of audioSegments(p, assets)) void mediaCache.loadAudio(seg.assetId);
    if (this.playing && structural) {
      // Re-schedule audio so edits during playback are heard.
      const t = this.currentTime();
      this.stopAudio();
      this.startAudio(t);
    }
    this.requestDraw();
  }

  setOptions(o: Partial<PreviewOptions>) {
    this.opts = { ...this.opts, ...o };
    this.resize();
    this.requestDraw();
  }

  private resize() {
    if (!this.project) return;
    const w = Math.max(2, Math.round(this.project.settings.width * this.opts.quality));
    const h = Math.max(2, Math.round(this.project.settings.height * this.opts.quality));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  duration(): number {
    return this.project ? projectDurationUs(this.project) : 0;
  }

  currentTime(): number {
    if (this.playing && this.audioCtx) {
      // Picture follows the audio actually being heard: subtract the output pipeline latency.
      const ac = this.audioCtx;
      const latency = (ac.outputLatency || 0) + (ac.baseLatency || 0);
      return this.playStartUs + Math.max(0, ac.currentTime - latency - this.ctxStart) * 1e6;
    }
    return this.timeUs;
  }

  seek(t: number) {
    this.timeUs = Math.max(0, Math.round(t));
    if (this.playing) {
      this.stopAudio();
      this.startAudio(this.timeUs);
    }
    this.requestDraw();
  }

  private starting = false;

  async play() {
    if (!this.project || this.playing) return;
    // A second play request while audio is still loading acts as "cancel" (toggle semantics).
    if (this.starting) {
      this.starting = false;
      this.onStatus(null);
      return;
    }
    this.starting = true;
    const dur = this.duration();
    if (dur <= 0) return;
    if (this.timeUs >= dur - 1000) this.timeUs = 0;
    if (!this.audioCtx) this.audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await this.audioCtx.resume();
    // Make sure audio for segments is decoded before starting (avoid silent start).
    const segs = audioSegments(this.project, this.assets);
    const pending = segs.filter((s) => mediaCache.audioIfReady(s.assetId) === undefined);
    if (pending.length) {
      this.onStatus('Loading audio…');
      await Promise.all(pending.map((s) => mediaCache.loadAudio(s.assetId)));
      this.onStatus(null);
    }
    if (!this.starting) return; // canceled while loading
    this.starting = false;
    this.playing = true;
    this.startAudio(this.timeUs);
    this.loop();
  }

  pause() {
    this.starting = false;
    if (!this.playing) return;
    this.timeUs = Math.round(this.currentTime());
    this.playing = false;
    this.stopAudio();
    for (const s of this.slots.values()) s.el.pause();
    cancelAnimationFrame(this.raf);
    this.onTime(this.timeUs);
    this.requestDraw();
  }

  private startAudio(fromUs: number) {
    if (!this.audioCtx || !this.project) return;
    const buffers = new Map<string, AudioBuffer>();
    const segs = audioSegments(this.project, this.assets);
    for (const s of segs) {
      const b = mediaCache.audioIfReady(s.assetId);
      if (b) buffers.set(s.assetId, b);
    }
    this.master?.input.disconnect();
    this.master?.limiter.disconnect();
    this.master = createMaster(this.audioCtx, this.project);
    this.ctxStart = this.audioCtx.currentTime + 0.05;
    this.playStartUs = fromUs;
    this.mix = scheduleSegments(this.audioCtx, this.master.input, segs, buffers, fromUs, this.ctxStart);
  }

  private stopAudio() {
    this.mix?.stop();
    this.mix = null;
  }

  private loop = () => {
    if (!this.playing) return;
    const t = this.currentTime();
    const dur = this.duration();
    if (t >= dur) {
      this.timeUs = dur;
      this.pause();
      this.onEnded();
      return;
    }
    this.timeUs = Math.max(this.playStartUs, t);
    const t0 = performance.now();
    this.drawNow();
    // Lightweight playback stats (read by perf tests / devtools): frames drawn and draw time.
    const stats = ((globalThis as { __ffPreviewStats?: { frames: number; drawMs: number } }).__ffPreviewStats ??= { frames: 0, drawMs: 0 });
    stats.frames++;
    stats.drawMs += performance.now() - t0;
    this.onTime(this.timeUs);
    this.raf = requestAnimationFrame(this.loop);
  };

  requestDraw() {
    if (this.playing || this.drawPending) return;
    this.drawPending = true;
    requestAnimationFrame(() => {
      this.drawPending = false;
      this.drawNow();
    });
  }

  private slotFor(clipId: string, assetId: string): VideoSlot {
    let s = this.slots.get(clipId);
    if (s && s.assetId !== assetId) {
      s.el.remove();
      this.slots.delete(clipId);
      s = undefined;
    }
    if (!s) {
      const el = document.createElement('video');
      el.muted = true;
      el.playsInline = true;
      el.preload = 'auto';
      el.crossOrigin = 'use-credentials';
      el.src = assetContentUrl(assetId);
      el.style.display = 'none';
      this.container.appendChild(el);
      const slot: VideoSlot = { el, assetId, lastUsed: performance.now(), seeking: false, pendingSeek: null };
      el.addEventListener('seeked', () => {
        slot.seeking = false;
        if (slot.pendingSeek !== null) {
          const next = slot.pendingSeek;
          slot.pendingSeek = null;
          this.seekSlot(slot, next);
        }
        this.requestDraw();
      });
      el.addEventListener('loadeddata', () => this.requestDraw());
      this.slots.set(clipId, slot);
      s = slot;
    }
    s.lastUsed = performance.now();
    return s;
  }

  private seekSlot(slot: VideoSlot, sec: number) {
    if (slot.seeking) {
      slot.pendingSeek = sec;
      return;
    }
    if (Math.abs(slot.el.currentTime - sec) < 0.001) return;
    slot.seeking = true;
    slot.el.currentTime = sec;
  }

  private sourceFor = (layer: VisualLayer): DrawableSource | null => {
    const clip = layer.clip;
    if (clip.kind === 'image') {
      const img = mediaCache.image(clip.assetId);
      return img ? { image: img, width: img.width, height: img.height } : null;
    }
    if (clip.kind === 'video') {
      const slot = this.slots.get(clip.id);
      if (!slot || slot.el.readyState < 2) return null;
      return { image: slot.el, width: slot.el.videoWidth, height: slot.el.videoHeight };
    }
    return null;
  };

  private syncVideos(t: number, layers: VisualLayer[]) {
    const p = this.project!;
    const active = new Set<string>();
    for (const l of layers) {
      if (l.clip.kind !== 'video') continue;
      active.add(l.clip.id);
      const slot = this.slotFor(l.clip.id, l.clip.assetId);
      const durSec = isFinite(slot.el.duration) ? slot.el.duration : Infinity;
      const target = Math.min(Math.max(0, l.sourceUs / 1e6), Math.max(0, durSec - 0.04));
      // Every visible layer plays — including transition pre/post-roll outside the clip's own range —
      // unless the source time is outside the media (then the edge frame is held, paused).
      const inRange = l.sourceUs / 1e6 > 0.001 && l.sourceUs / 1e6 < durSec - 0.05;
      if (this.playing && inRange) {
        // Sync stats (PREV-04): |video element time − clock-derived source time| in ms.
        if (!slot.seeking && slot.el.readyState >= 2 && !slot.el.paused) {
          const st = ((globalThis as { __ffSyncStats?: { samples: number; sumMs: number; maxMs: number; signedMs: number } }).__ffSyncStats ??= { samples: 0, sumMs: 0, maxMs: 0, signedMs: 0 });
          const signed = (slot.el.currentTime - target) * 1000; // + = video ahead of clock
          const d = Math.abs(signed);
          st.samples++;
          st.sumMs += d;
          st.signedMs = (st.signedMs ?? 0) + signed;
          st.maxMs = Math.max(st.maxMs, d);
        }
        // Rate-based fine sync: nudge playbackRate ±6% while 25–120 ms off (large errors re-seek).
        const diff = slot.el.currentTime - target;
        const rate = diff < -0.025 ? l.clip.speed * 1.06 : diff > 0.025 ? l.clip.speed * 0.94 : l.clip.speed;
        if (Math.abs(slot.el.playbackRate - rate) > 1e-6) slot.el.playbackRate = rate;
        if (Math.abs(slot.el.currentTime - target) > 0.12 && !slot.seeking) this.seekSlot(slot, target);
        // Hold video until the scheduled audio start so picture and sound begin together.
        const audioStarted = !this.audioCtx || this.audioCtx.currentTime - (this.audioCtx.outputLatency || 0) - (this.audioCtx.baseLatency || 0) >= this.ctxStart;
        if (slot.el.paused && !slot.seeking && audioStarted) void slot.el.play().catch(() => {});
      } else {
        if (!slot.el.paused) slot.el.pause();
        if (Math.abs(slot.el.currentTime - target) > 0.5 / p.settings.fps) this.seekSlot(slot, target);
      }
    }
    // Pre-roll clips starting within the next 1.5 s during playback.
    if (this.playing) {
      for (const track of p.tracks) {
        if (track.kind !== 'video' || track.hidden) continue;
        for (const c of track.clips) {
          if (c.kind !== 'video' || active.has(c.id)) continue;
          if (c.timelineStartUs > t && c.timelineStartUs - t < 1_500_000) {
            const slot = this.slotFor(c.id, c.assetId);
            if (!slot.el.paused) slot.el.pause();
            const target = c.sourceStartUs / 1e6;
            if (Math.abs(slot.el.currentTime - target) > 0.05) this.seekSlot(slot, target);
            active.add(c.id);
          }
        }
      }
    }
    for (const [id, s] of this.slots) {
      if (!active.has(id) && !s.el.paused) s.el.pause();
      // Release elements unused for 20s.
      if (!active.has(id) && performance.now() - s.lastUsed > 20_000) {
        s.el.removeAttribute('src');
        s.el.load();
        s.el.remove();
        this.slots.delete(id);
      }
    }
  }

  drawNow() {
    const p = this.project;
    if (!p) return;
    const t = this.playing ? this.currentTime() : this.timeUs;
    const layers = evaluateVisualLayers(p, t);
    this.syncVideos(t, layers);
    const loading = layers.some((l) => {
      if (l.clip.kind === 'video') return (this.slots.get(l.clip.id)?.el.readyState ?? 0) < 2;
      if (l.clip.kind === 'image') return !mediaCache.image(l.clip.assetId);
      return false;
    });
    if (loading !== this.loadingShown) {
      this.loadingShown = loading;
      this.onStatus(loading ? 'Loading media…' : null);
    }
    renderFrame(this.ctx2d, p, t, this.sourceFor, {
      scale: this.canvas.width / p.settings.width,
      captions: p.captions.enabled,
      guides: this.opts.guides,
      selectedClipIds: this.playing ? [] : this.opts.selectedClipIds,
    });
  }
}

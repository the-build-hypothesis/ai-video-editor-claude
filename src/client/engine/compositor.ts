/**
 * Canvas compositor — the single drawing routine used by BOTH the live preview and the MP4 exporter,
 * so what you see is what gets encoded (PREV-03). Only the frame *source* differs:
 * preview passes HTMLVideoElement frames, export passes exact decoded WebCodecs frames.
 */
import type { Project, TextClip, Transform, Adjust, CaptionSegment } from '../../shared/model';
import { evaluateVisualLayers, activeCaption, textAnimation, type VisualLayer } from '../../shared/timeline-eval';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export interface DrawableSource {
  image: CanvasImageSource;
  width: number;
  height: number;
}
export type SourceResolver = (layer: VisualLayer) => DrawableSource | null;

export interface RenderOptions {
  /** Canvas pixels per project pixel (preview quality); export uses outputWidth / project.width. */
  scale: number;
  captions: boolean;
  /** Draw safe-area guides (preview only). */
  guides?: boolean;
  /** Highlight a selected clip id with an outline (preview only). */
  selectedClipIds?: string[];
}

const FONT_STACK: Record<string, string> = {
  Inter: 'Inter, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  Georgia: 'Georgia, "Times New Roman", serif',
  'Courier New': '"Courier New", Courier, monospace',
  Impact: 'Impact, "Arial Black", sans-serif',
  Arial: 'Arial, Helvetica, sans-serif',
};

export function filterFor(adj: Adjust | undefined): string {
  if (!adj) return 'none';
  const parts: string[] = [];
  if (adj.brightness) parts.push(`brightness(${(1 + adj.brightness).toFixed(3)})`);
  if (adj.contrast) parts.push(`contrast(${(1 + adj.contrast).toFixed(3)})`);
  if (adj.saturation) parts.push(`saturate(${(1 + adj.saturation).toFixed(3)})`);
  return parts.length ? parts.join(' ') : 'none';
}

/** Compute destination rect (centered at origin) for a source of size sw×sh in a W×H frame. */
export function fitRect(sw: number, sh: number, W: number, H: number, tr: Transform) {
  let w: number;
  let h: number;
  switch (tr.fit) {
    case 'cover': {
      const s = Math.max(W / sw, H / sh);
      w = sw * s;
      h = sh * s;
      break;
    }
    case 'stretch':
      w = W;
      h = H;
      break;
    case 'none':
      w = sw;
      h = sh;
      break;
    default: {
      const s = Math.min(W / sw, H / sh);
      w = sw * s;
      h = sh * s;
    }
  }
  return { w: w * tr.scale, h: h * tr.scale };
}

export function renderFrame(ctx: Ctx2D, p: Project, t: number, resolve: SourceResolver, opts: RenderOptions): VisualLayer[] {
  const W = p.settings.width;
  const H = p.settings.height;
  ctx.save();
  ctx.setTransform(opts.scale, 0, 0, opts.scale, 0, 0);
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.fillStyle = p.settings.backgroundColor;
  ctx.fillRect(0, 0, W, H);
  const layers = evaluateVisualLayers(p, t);
  for (const layer of layers) {
    if (layer.clip.kind === 'text') drawText(ctx, layer.clip, layer, W, H);
    else drawMedia(ctx, layer, resolve(layer), W, H);
  }
  if (opts.captions) {
    const cap = activeCaption(p, t);
    if (cap) drawCaption(ctx, p, cap, W, H);
  }
  if (opts.selectedClipIds?.length) {
    for (const layer of layers) {
      if (!opts.selectedClipIds.includes(layer.clip.id)) continue;
      const r = layerBounds(ctx, layer, resolve, W, H);
      if (!r) continue;
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.translate(W / 2 + layer.clip.transform.x, H / 2 + layer.clip.transform.y);
      ctx.rotate((layer.clip.transform.rotation * Math.PI) / 180);
      ctx.strokeStyle = '#8b7dff';
      ctx.lineWidth = 3 / opts.scale;
      ctx.setLineDash([12 / opts.scale, 8 / opts.scale]);
      ctx.strokeRect(-r.w / 2, -r.h / 2, r.w, r.h);
      ctx.restore();
    }
  }
  if (opts.guides) {
    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = '#ffd400';
    ctx.lineWidth = 2 / opts.scale;
    ctx.setLineDash([10 / opts.scale, 10 / opts.scale]);
    ctx.strokeRect(W * 0.05, H * 0.05, W * 0.9, H * 0.9); // action safe
    ctx.strokeStyle = '#00e0ff';
    ctx.strokeRect(W * 0.1, H * 0.1, W * 0.8, H * 0.8); // title safe
    ctx.restore();
  }
  ctx.restore();
  return layers;
}

function layerBounds(ctx: Ctx2D, layer: VisualLayer, resolve: SourceResolver, W: number, H: number) {
  if (layer.clip.kind === 'text') {
    const m = measureText(ctx, layer.clip, W);
    return { w: m.boxW * layer.clip.transform.scale, h: m.boxH * layer.clip.transform.scale };
  }
  const src = resolve(layer);
  if (!src) return null;
  const c = layer.clip.transform.crop;
  return fitRect(src.width * (1 - c.left - c.right), src.height * (1 - c.top - c.bottom), W, H, layer.clip.transform);
}

function drawMedia(ctx: Ctx2D, layer: VisualLayer, src: DrawableSource | null, W: number, H: number) {
  if (!src || src.width === 0 || src.height === 0) return;
  const clip = layer.clip as Exclude<typeof layer.clip, TextClip>;
  const tr = clip.transform;
  const cr = tr.crop;
  const sx = src.width * cr.left;
  const sy = src.height * cr.top;
  const sw = Math.max(1, src.width * (1 - cr.left - cr.right));
  const sh = Math.max(1, src.height * (1 - cr.top - cr.bottom));
  const { w, h } = fitRect(sw, sh, W, H, tr);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity * tr.opacity));
  if (layer.wipe) {
    const rw = W * layer.wipe.progress;
    ctx.beginPath();
    if (layer.wipe.from === 'left') ctx.rect(0, 0, rw, H);
    else ctx.rect(W - rw, 0, rw, H);
    ctx.clip();
  }
  ctx.translate(W / 2 + tr.x, H / 2 + tr.y);
  if (tr.rotation) ctx.rotate((tr.rotation * Math.PI) / 180);
  ctx.filter = filterFor(clip.adjust);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src.image, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
  ctx.restore();
}

function fontFor(style: TextClip['style'], size: number) {
  return `${style.italic ? 'italic ' : ''}${style.bold ? '700' : '400'} ${size}px ${FONT_STACK[style.fontFamily] ?? FONT_STACK.Inter}`;
}

export function wrapLines(ctx: Ctx2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const test = line + ' ' + words[i];
      if (ctx.measureText(test).width > maxWidth) {
        out.push(line);
        line = words[i];
      } else line = test;
    }
    out.push(line);
  }
  return out;
}

function measureText(ctx: Ctx2D, clip: TextClip, W: number) {
  const st = clip.style;
  ctx.font = fontFor(st, st.fontSize);
  const lines = wrapLines(ctx, clip.text, W * 0.9);
  const lh = st.fontSize * 1.2;
  const widths = lines.map((l) => ctx.measureText(l).width);
  const pad = st.background ? st.fontSize * 0.35 : 0;
  const maxW = Math.max(1, ...widths);
  return { lines, widths, lh, pad, boxW: maxW + pad * 2, boxH: lines.length * lh + pad * 2 };
}

function drawText(ctx: Ctx2D, clip: TextClip, layer: VisualLayer, W: number, H: number) {
  if (!clip.text.trim()) return;
  const anim = textAnimation(clip, layer.localUs);
  const st = clip.style;
  const tr = clip.transform;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity * tr.opacity * anim.opacity));
  ctx.translate(W / 2 + tr.x, H / 2 + tr.y + anim.dy);
  if (tr.rotation) ctx.rotate((tr.rotation * Math.PI) / 180);
  const s = tr.scale * anim.scale;
  ctx.scale(s, s);
  const m = measureText(ctx, clip, W);
  const visible = anim.chars < clip.text.length ? wrapLines(ctx, clip.text.slice(0, anim.chars), W * 0.9) : m.lines;
  const totalH = m.lines.length * m.lh;
  const top = -totalH / 2;
  // Box anchor: text block is centered at the transform position; align controls line alignment within the block.
  const left = -m.boxW / 2 + m.pad;
  if (st.background) {
    ctx.fillStyle = st.background;
    roundRect(ctx, -m.boxW / 2, top - m.pad, m.boxW, totalH + m.pad * 2, st.fontSize * 0.18);
    ctx.fill();
  }
  ctx.textBaseline = 'middle';
  ctx.font = fontFor(st, st.fontSize);
  if (st.shadow && !st.background) {
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = st.fontSize * 0.12;
    ctx.shadowOffsetY = st.fontSize * 0.04;
  }
  visible.forEach((line, i) => {
    const lw = ctx.measureText(line).width;
    const innerW = m.boxW - m.pad * 2;
    let x = left;
    if (st.align === 'center') x = left + (innerW - lw) / 2;
    else if (st.align === 'right') x = left + innerW - lw;
    const y = top + m.lh * (i + 0.5);
    if (st.strokeColor && st.strokeWidth > 0) {
      ctx.lineJoin = 'round';
      ctx.strokeStyle = st.strokeColor;
      ctx.lineWidth = st.strokeWidth;
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = st.color;
    ctx.fillText(line, x, y);
  });
  ctx.restore();
}

function drawCaption(ctx: Ctx2D, p: Project, cap: CaptionSegment, W: number, H: number) {
  const st = p.captions.style;
  if (!cap.text.trim()) return;
  ctx.save();
  ctx.font = `${st.bold ? '700' : '400'} ${st.fontSize}px ${FONT_STACK.Inter}`;
  const lines = wrapLines(ctx, cap.text, W * 0.8);
  const lh = st.fontSize * 1.25;
  const pad = st.fontSize * 0.3;
  const blockH = lines.length * lh;
  let top: number;
  if (st.position === 'top') top = H * st.margin;
  else if (st.position === 'middle') top = (H - blockH) / 2;
  else top = H - H * st.margin - blockH;
  ctx.textBaseline = 'middle';
  lines.forEach((line, i) => {
    const lw = ctx.measureText(line).width;
    const y = top + lh * i;
    if (st.background) {
      ctx.fillStyle = st.background;
      roundRect(ctx, (W - lw) / 2 - pad, y, lw + pad * 2, lh, st.fontSize * 0.15);
      ctx.fill();
    } else {
      ctx.lineWidth = st.fontSize * 0.12;
      ctx.strokeStyle = '#000000';
      ctx.lineJoin = 'round';
      ctx.strokeText(line, (W - lw) / 2, y + lh / 2);
    }
    ctx.fillStyle = st.color;
    ctx.fillText(line, (W - lw) / 2, y + lh / 2);
  });
  ctx.restore();
}

function roundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  const c = ctx as CanvasRenderingContext2D;
  if (typeof c.roundRect === 'function') c.roundRect(x, y, w, h, r);
  else c.rect(x, y, w, h);
}

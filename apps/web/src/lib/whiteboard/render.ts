/**
 * Canvas renderer shared by the teacher editor and every viewer (students on
 * phones/tablets/desktops, admin preview, Windows app). Draws one page in page
 * units through a view transform, so the picture is identical everywhere and
 * only scaled.
 */
import { PAGE_H, PAGE_W, type Background, type Item, type Page } from './model';

export type View = { scale: number; tx: number; ty: number };

/** Fit the page into a box (letterboxed, centred). */
export function fitView(boxW: number, boxH: number): View {
  const scale = Math.max(0.01, Math.min(boxW / PAGE_W, boxH / PAGE_H));
  return { scale, tx: (boxW - PAGE_W * scale) / 2, ty: (boxH - PAGE_H * scale) / 2 };
}

/** Screen point → page point. */
export function toPage(v: View, x: number, y: number): { x: number; y: number } {
  return { x: (x - v.tx) / v.scale, y: (y - v.ty) / v.scale };
}

const imgCache = new Map<string, HTMLImageElement>();
function imageFor(src: string, onLoad?: () => void): HTMLImageElement | null {
  if (typeof Image === 'undefined') return null;
  let img = imgCache.get(src);
  if (!img) {
    img = new Image();
    img.onload = () => onLoad?.();
    img.src = src;
    imgCache.set(src, img);
    if (imgCache.size > 200) imgCache.delete(imgCache.keys().next().value as string);
  }
  return img.complete && img.naturalWidth ? img : null;
}

export function bgColor(bg: Background): string {
  return bg === 'black' ? '#111418' : '#ffffff';
}

function drawBackground(ctx: CanvasRenderingContext2D, bg: Background) {
  ctx.fillStyle = bgColor(bg);
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  if (bg === 'grid' || bg === 'lined') {
    ctx.strokeStyle = bg === 'grid' ? '#d6dde6' : '#c9d7ee';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const step = 60;
    for (let y = step; y < PAGE_H; y += step) {
      ctx.moveTo(0, y);
      ctx.lineTo(PAGE_W, y);
    }
    if (bg === 'grid') {
      for (let x = step; x < PAGE_W; x += step) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, PAGE_H);
      }
    }
    ctx.stroke();
    if (bg === 'lined') {
      ctx.strokeStyle = '#f2a7a7';
      ctx.beginPath();
      ctx.moveTo(120, 0);
      ctx.lineTo(120, PAGE_H);
      ctx.stroke();
    }
  }
}

export function drawItem(ctx: CanvasRenderingContext2D, it: Item, onImage?: () => void) {
  ctx.save();
  switch (it.k) {
    case 'stroke': {
      ctx.strokeStyle = it.c;
      ctx.fillStyle = it.c;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (it.tool === 'hl') {
        ctx.globalAlpha = 0.35;
        ctx.lineCap = 'butt';
      }
      ctx.lineWidth = it.w;
      const p = it.pts;
      if (p.length === 2) {
        ctx.beginPath();
        ctx.arc(p[0]!, p[1]!, it.w / 2, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      ctx.beginPath();
      ctx.moveTo(p[0]!, p[1]!);
      // Quadratic smoothing through midpoints.
      for (let i = 2; i + 3 < p.length; i += 2) {
        const mx = (p[i]! + p[i + 2]!) / 2;
        const my = (p[i + 1]! + p[i + 3]!) / 2;
        ctx.quadraticCurveTo(p[i]!, p[i + 1]!, mx, my);
      }
      if (p.length >= 4) ctx.lineTo(p[p.length - 2]!, p[p.length - 1]!);
      ctx.stroke();
      break;
    }
    case 'line':
    case 'arrow': {
      ctx.strokeStyle = it.c;
      ctx.lineWidth = it.w;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(it.x1, it.y1);
      ctx.lineTo(it.x2, it.y2);
      ctx.stroke();
      if (it.k === 'arrow') {
        const a = Math.atan2(it.y2 - it.y1, it.x2 - it.x1);
        const len = Math.max(14, it.w * 4);
        ctx.fillStyle = it.c;
        ctx.beginPath();
        ctx.moveTo(it.x2, it.y2);
        ctx.lineTo(it.x2 - len * Math.cos(a - 0.45), it.y2 - len * Math.sin(a - 0.45));
        ctx.lineTo(it.x2 - len * Math.cos(a + 0.45), it.y2 - len * Math.sin(a + 0.45));
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case 'rect':
      ctx.strokeStyle = it.c;
      ctx.lineWidth = it.w;
      ctx.lineJoin = 'round';
      ctx.strokeRect(Math.min(it.x1, it.x2), Math.min(it.y1, it.y2), Math.abs(it.x2 - it.x1), Math.abs(it.y2 - it.y1));
      break;
    case 'ellipse':
      ctx.strokeStyle = it.c;
      ctx.lineWidth = it.w;
      ctx.beginPath();
      ctx.ellipse((it.x1 + it.x2) / 2, (it.y1 + it.y2) / 2, Math.abs(it.x2 - it.x1) / 2, Math.abs(it.y2 - it.y1) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'text': {
      ctx.fillStyle = it.c;
      ctx.font = `${it.size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      ctx.textBaseline = 'top';
      it.text.split('\n').forEach((line, i) => ctx.fillText(line, it.x, it.y + i * it.size * 1.25));
      break;
    }
    case 'img': {
      const img = imageFor(it.src, onImage);
      if (img) ctx.drawImage(img, it.x, it.y, it.w, it.h);
      else {
        ctx.strokeStyle = '#94a3b8';
        ctx.setLineDash([12, 8]);
        ctx.strokeRect(it.x, it.y, it.w, it.h);
      }
      break;
    }
  }
  ctx.restore();
}

/**
 * Draw `page` into `ctx` (canvas of cssW x cssH CSS px at device ratio dpr)
 * through view `v`. `extra` = in-progress items (local preview).
 */
export function renderPage(
  ctx: CanvasRenderingContext2D,
  page: Page,
  v: View,
  opts: { cssW: number; cssH: number; dpr: number; extra?: Item[]; onImage?: () => void; outside?: string }
) {
  ctx.setTransform(opts.dpr, 0, 0, opts.dpr, 0, 0);
  ctx.fillStyle = opts.outside ?? '#0b0f14';
  ctx.fillRect(0, 0, opts.cssW, opts.cssH);
  ctx.setTransform(opts.dpr * v.scale, 0, 0, opts.dpr * v.scale, opts.dpr * v.tx, opts.dpr * v.ty);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, PAGE_W, PAGE_H);
  ctx.clip();
  drawBackground(ctx, page.bg);
  for (const it of page.items) drawItem(ctx, it, opts.onImage);
  for (const it of opts.extra ?? []) drawItem(ctx, it, opts.onImage);
  ctx.restore();
}

/** Render a page at full page resolution (export). */
export function renderPageToCanvas(page: Page, canvas: HTMLCanvasElement, onImage?: () => void) {
  canvas.width = PAGE_W;
  canvas.height = PAGE_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  renderPage(ctx, page, { scale: 1, tx: 0, ty: 0 }, { cssW: PAGE_W, cssH: PAGE_H, dpr: 1, onImage });
}

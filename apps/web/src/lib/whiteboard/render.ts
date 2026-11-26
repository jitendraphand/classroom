/**
 * Canvas renderer shared by the teacher editor and every viewer (students on
 * phones/tablets/desktops, admin preview, Windows app). Draws one page in page
 * units through a view transform, so the picture is identical everywhere and
 * only scaled.
 */
import { BOARD_MAX_H, LASER_MS, PAGE_H, PAGE_W, itemBounds, triPoints, type Background, type Item, type LaserTrail, type Page, type ShapeItem } from './model';

export type View = { scale: number; tx: number; ty: number };

/** Fit the page into a box (letterboxed, centred). */
export function fitView(boxW: number, boxH: number): View {
  const scale = Math.max(0.01, Math.min(boxW / PAGE_W, boxH / PAGE_H));
  return { scale, tx: (boxW - PAGE_W * scale) / 2, ty: (boxH - PAGE_H * scale) / 2 };
}

/**
 * One long page (Nov 2026): the band y..y+h of the page in a box.
 * - 'edit' (teacher): the page width fills the box; the box height decides how
 *   much of the page shows below y.
 * - 'follow' (students, admin): the teacher's whole band fits (width or height,
 *   whichever is tighter), top-aligned, so a student never misses what the
 *   teacher sees; a taller screen shows more below it.
 */
export function bandView(boxW: number, boxH: number, band: { y: number; h: number }, mode: 'edit' | 'follow'): View {
  const fitW = boxW / PAGE_W;
  const scale = Math.max(0.01, mode === 'edit' ? fitW : Math.min(fitW, boxH / Math.max(1, band.h)));
  return { scale, tx: (boxW - PAGE_W * scale) / 2, ty: -band.y * scale };
}

/** Visible height of a box in page units (teacher's band height). */
export function visibleH(v: View, boxH: number): number {
  return Math.round(boxH / Math.max(0.01, v.scale));
}

/** Screen point → page point. */
export function toPage(v: View, x: number, y: number): { x: number; y: number } {
  return { x: (x - v.tx) / v.scale, y: (y - v.ty) / v.scale };
}

const imgCache = new Map<string, HTMLImageElement>();
let assetUrl: ((id: string) => string) | null = null;
/** Where `asset:<id>` images are fetched from (set by the class page: needs the class code). */
export function setAssetUrlResolver(fn: ((id: string) => string) | null) {
  assetUrl = fn;
}
function imageFor(src: string, onLoad?: () => void): HTMLImageElement | null {
  if (typeof Image === 'undefined') return null;
  let img = imgCache.get(src);
  if (!img) {
    const url = src.startsWith('asset:') ? assetUrl?.(src.slice(6)) : src;
    if (!url) return null;
    img = new Image();
    img.onload = () => onLoad?.();
    img.src = url;
    imgCache.set(src, img);
    if (imgCache.size > 200) imgCache.delete(imgCache.keys().next().value as string);
  }
  return img.complete && img.naturalWidth ? img : null;
}

export function bgColor(bg: Background): string {
  return bg === 'black' ? '#111418' : '#ffffff';
}

/** First multiple of `step` after `y0` (patterns stay fixed to the page while it scrolls). */
const firstStep = (y0: number, step: number) => Math.max(step, Math.ceil(y0 / step) * step);

/** Background of the band y0..y1 (page units). */
function drawBackground(ctx: CanvasRenderingContext2D, bg: Background, y0 = 0, y1 = PAGE_H) {
  ctx.fillStyle = bgColor(bg);
  ctx.fillRect(0, y0, PAGE_W, y1 - y0);
  if (bg === 'dots') {
    ctx.fillStyle = '#b8c2cf';
    const step = 40;
    for (let y = firstStep(y0, step); y < y1; y += step) {
      for (let x = step; x < PAGE_W; x += step) {
        ctx.beginPath();
        ctx.arc(x, y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    return;
  }
  if (bg === 'graph') {
    // Graph paper: a fine 20-unit grid with a darker line every 100 units.
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#e4e9f0';
    ctx.beginPath();
    for (let v = 20; v < PAGE_W; v += 20) if (v % 100) { ctx.moveTo(v, y0); ctx.lineTo(v, y1); }
    for (let v = firstStep(y0, 20); v < y1; v += 20) if (v % 100) { ctx.moveTo(0, v); ctx.lineTo(PAGE_W, v); }
    ctx.stroke();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#b9c6d6';
    ctx.beginPath();
    for (let v = 100; v < PAGE_W; v += 100) { ctx.moveTo(v, y0); ctx.lineTo(v, y1); }
    for (let v = firstStep(y0, 100); v < y1; v += 100) { ctx.moveTo(0, v); ctx.lineTo(PAGE_W, v); }
    ctx.stroke();
    return;
  }
  if (bg === 'grid' || bg === 'lined') {
    ctx.strokeStyle = bg === 'grid' ? '#d6dde6' : '#c9d7ee';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const step = 60;
    for (let y = firstStep(y0, step); y < y1; y += step) {
      ctx.moveTo(0, y);
      ctx.lineTo(PAGE_W, y);
    }
    if (bg === 'grid') {
      for (let x = step; x < PAGE_W; x += step) {
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y1);
      }
    }
    ctx.stroke();
    if (bg === 'lined') {
      ctx.strokeStyle = '#f2a7a7';
      ctx.beginPath();
      ctx.moveTo(120, y0);
      ctx.lineTo(120, y1);
      ctx.stroke();
    }
  }
}

/** Width of a pressure stroke at pressure `pr` (0–100): 35 % of the pen width at zero, 125 % at full. */
export function widthAt(w: number, pr: number): number {
  return w * (0.35 + (0.9 * pr) / 100);
}

/**
 * Stylus stroke: the same midpoint-smoothed path as a plain stroke, drawn as
 * one segment per point so the width follows the pressure.
 */
function drawPressureStroke(ctx: CanvasRenderingContext2D, p: number[], pr: number[], w: number) {
  const n = p.length / 2;
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(p[0]!, p[1]!, widthAt(w, pr[0]!) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  let sx = p[0]!, sy = p[1]!;
  for (let i = 1; i < n - 1; i++) {
    const mx = (p[2 * i]! + p[2 * i + 2]!) / 2, my = (p[2 * i + 1]! + p[2 * i + 3]!) / 2;
    ctx.lineWidth = widthAt(w, pr[i]!);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(p[2 * i]!, p[2 * i + 1]!, mx, my);
    ctx.stroke();
    sx = mx;
    sy = my;
  }
  ctx.lineWidth = widthAt(w, pr[n - 1]!);
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(p[2 * n - 2]!, p[2 * n - 1]!);
  ctx.stroke();
}

/** Outline of a closed shape (rect, ellipse, triangle) as the current path. */
function shapePath(ctx: CanvasRenderingContext2D, it: ShapeItem) {
  ctx.beginPath();
  if (it.k === 'rect') ctx.rect(Math.min(it.x1, it.x2), Math.min(it.y1, it.y2), Math.abs(it.x2 - it.x1), Math.abs(it.y2 - it.y1));
  else if (it.k === 'ellipse') ctx.ellipse((it.x1 + it.x2) / 2, (it.y1 + it.y2) / 2, Math.abs(it.x2 - it.x1) / 2, Math.abs(it.y2 - it.y1) / 2, 0, 0, Math.PI * 2);
  else {
    const [a, b, c] = triPoints(it);
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.closePath();
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
      if (it.pr && it.tool === 'pen' && it.pr.length === p.length / 2) {
        drawPressureStroke(ctx, p, it.pr, it.w);
        break;
      }
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
    case 'ellipse':
    case 'tri':
      shapePath(ctx, it);
      if (it.fl) {
        ctx.fillStyle = it.c;
        ctx.globalAlpha = 0.22;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = it.c;
      ctx.lineWidth = it.w;
      ctx.lineJoin = 'round';
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
      if (img) {
        ctx.drawImage(img, it.x, it.y, it.w, it.h);
        if (it.bd) {
          // PDF page: a thin grey edge so consecutive white pages stay apart.
          ctx.strokeStyle = '#94a3b8';
          ctx.lineWidth = 2;
          ctx.strokeRect(it.x - 1, it.y - 1, it.w + 2, it.h + 2);
        }
      } else {
        ctx.strokeStyle = '#94a3b8';
        ctx.setLineDash([12, 8]);
        ctx.strokeRect(it.x, it.y, it.w, it.h);
      }
      break;
    }
  }
  ctx.restore();
}

const boundsCache = new WeakMap<Item, { y: number; b: number; n: number }>();
/** Vertical extent of an item (cached per object; strokes re-measure when they grow). */
function vExtent(it: Item): { y: number; b: number } {
  const n = it.k === 'stroke' ? it.pts.length : 0;
  const c = boundsCache.get(it);
  if (c && c.n === n) return c;
  const r = itemBounds(it);
  const e = { y: r.y, b: r.y + r.h, n };
  boundsCache.set(it, e);
  return e;
}

/** The page band a view shows in a box cssH tall (clamped to the page). */
export function shownBand(v: View, cssH: number): { y0: number; y1: number } {
  const y0 = Math.max(0, -v.ty / v.scale);
  const y1 = Math.min(BOARD_MAX_H, (cssH - v.ty) / v.scale);
  return { y0, y1: Math.max(y0, y1) };
}

/** Items that reach into y0..y1 (a long board only draws what is on screen). */
export function itemsInBand(items: Item[], y0: number, y1: number): Item[] {
  return items.filter((it) => {
    const e = vExtent(it);
    return e.b >= y0 && e.y <= y1;
  });
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
  const { y0, y1 } = shownBand(v, opts.cssH);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, PAGE_W, BOARD_MAX_H);
  ctx.clip();
  drawBackground(ctx, page.bg, Math.floor(y0), Math.ceil(y1));
  for (const it of itemsInBand(page.items, y0, y1)) drawItem(ctx, it, opts.onImage);
  for (const it of opts.extra ?? []) drawItem(ctx, it, opts.onImage);
  ctx.restore();
}

/**
 * Laser trail over the page (same view transform as the page). Points fade
 * out over LASER_MS; the newest point is the bright head.
 */
export function drawLaser(ctx: CanvasRenderingContext2D, trail: LaserTrail, v: View, dpr: number, now = Date.now()) {
  const pts = trail.pts;
  if (!pts.length) return;
  ctx.save();
  ctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.tx, dpr * v.ty);
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#ef4444';
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    if (b.t - a.t > 250) continue; // a gap: the pointer left and came back
    ctx.globalAlpha = Math.max(0, 1 - (now - b.t) / LASER_MS) * 0.85;
    // Screen-constant size: as visible on a phone as on a projector.
    ctx.lineWidth = 5 / v.scale;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  const head = pts[pts.length - 1]!;
  const alpha = Math.max(0, 1 - (now - head.t) / LASER_MS);
  if (alpha > 0) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(head.x, head.y, 8 / v.scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(head.x, head.y, 3 / v.scale, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Render the band y..y+h of a page at full page resolution (export; default the top screen). */
export function renderPageToCanvas(page: Page, canvas: HTMLCanvasElement, onImage?: () => void, band: { y: number; h: number } = { y: 0, h: PAGE_H }) {
  canvas.width = PAGE_W;
  canvas.height = band.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  renderPage(ctx, page, { scale: 1, tx: 0, ty: -band.y }, { cssW: PAGE_W, cssH: band.h, dpr: 1, onImage });
}

type LayerCanvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Key of the cached static layer: page structure, view and canvas size. */
export function layerKey(p: { pageId: string; bg: string; structVersion: number; hot: Iterable<string>; v: View; W: number; H: number }): string {
  return `${p.pageId}|${p.bg}|${p.structVersion}|${[...p.hot].sort().join(',')}|${p.v.scale.toFixed(5)},${p.v.tx.toFixed(2)},${p.v.ty.toFixed(2)}|${p.W}x${p.H}`;
}

/**
 * Layered page renderer (round 6: teacher whiteboard CPU ~50%). Everything
 * except the strokes that are still growing is painted once into an
 * (Offscreen)canvas layer; each frame while someone draws blits that layer and
 * draws only the growing strokes and the local preview, instead of
 * re-drawing every item of the page per pointer move.
 */
export class LayeredRenderer {
  private layer: LayerCanvas | null = null;
  private key = '';
  rebuilds = 0;

  render(
    ctx: CanvasRenderingContext2D,
    page: Page,
    v: View,
    opts: { cssW: number; cssH: number; dpr: number; extra?: Item[]; onImage?: () => void; outside?: string; structVersion: number; hot: Set<string> }
  ) {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const key = layerKey({ pageId: page.id, bg: page.bg, structVersion: opts.structVersion, hot: opts.hot, v, W, H });
    if (key !== this.key || !this.layer) {
      if (!this.layer || this.layer.width !== W || this.layer.height !== H) this.layer = makeLayer(W, H, ctx.canvas);
      const lctx = this.layer.getContext('2d') as Ctx2D | null;
      if (!lctx) return renderPage(ctx, page, v, opts);
      const still = opts.hot.size ? { ...page, items: page.items.filter((it) => !opts.hot.has(it.id)) } : page;
      renderPage(lctx as CanvasRenderingContext2D, still, v, { ...opts, extra: undefined });
      this.key = key;
      this.rebuilds++;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.layer as CanvasImageSource, 0, 0);
    const live = opts.hot.size ? page.items.filter((it) => opts.hot.has(it.id)) : [];
    if (!live.length && !opts.extra?.length) return;
    ctx.setTransform(opts.dpr * v.scale, 0, 0, opts.dpr * v.scale, opts.dpr * v.tx, opts.dpr * v.ty);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, PAGE_W, BOARD_MAX_H);
    ctx.clip();
    for (const it of live) drawItem(ctx, it, opts.onImage);
    for (const it of opts.extra ?? []) drawItem(ctx, it, opts.onImage);
    ctx.restore();
  }

  invalidate() {
    this.key = '';
  }
}

function makeLayer(W: number, H: number, like: HTMLCanvasElement | OffscreenCanvas): LayerCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(W, H);
  const doc = (like as HTMLCanvasElement).ownerDocument ?? document;
  const c = doc.createElement('canvas');
  c.width = W;
  c.height = H;
  return c;
}

/** Wait (up to `timeoutMs`) until the images of `items` are loaded (export draws them). */
export async function preloadImages(items: Item[], timeoutMs = 8000): Promise<void> {
  const waits: Promise<void>[] = [];
  for (const it of items) {
    if (it.k !== 'img') continue;
    waits.push(
      new Promise<void>((resolve) => {
        if (imageFor(it.src, () => resolve())) return resolve();
        const img = imgCache.get(it.src);
        if (!img) return resolve();
        img.addEventListener('error', () => resolve(), { once: true });
        img.addEventListener('load', () => resolve(), { once: true });
      })
    );
  }
  if (!waits.length) return;
  await Promise.race([Promise.all(waits).then(() => undefined), new Promise<void>((r) => setTimeout(r, timeoutMs))]);
}

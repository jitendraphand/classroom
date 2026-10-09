/** Screen-share annotation geometry. Matches apps/web/src/lib/annotateGeometry.ts. */

export type Pt = [number, number];
export type StrokeLike = { id: string; width: number; points: Pt[] };

export const SNAPSHOT_BUDGET_BYTES = 250_000;

export type AnnotateTool = 'pen' | 'highlighter';
export type AnnotateMode = AnnotateTool | 'eraser';

export type AnnotateStroke = {
  id: string;
  tool: AnnotateTool;
  color: string;
  width: number;
  points: Pt[];
};

export type AnnotateMsg =
  | { v: 1; type: 'begin'; stroke: AnnotateStroke; from: string }
  | { v: 1; type: 'point'; id: string; p: Pt; from: string }
  | { v: 1; type: 'points'; id: string; pts: Pt[]; from: string }
  | { v: 1; type: 'end'; id: string; from: string }
  | { v: 1; type: 'erase'; ids: string[]; from: string }
  | { v: 1; type: 'clear'; from: string }
  | { v: 1; type: 'undo'; id: string; from: string }
  | { v: 1; type: 'snapshot'; strokes: AnnotateStroke[]; from: string };

export const ANNOTATE_COLORS = ['#ef4444', '#22c55e', '#f59e0b', '#3b82f6', '#ffffff'];
export const TOOL_WIDTH: Record<AnnotateTool, number> = { pen: 3, highlighter: 18 };
export const ANNOTATE_TOPIC = 'annotate';
/** Matches the website SVG highlighter opacity. */
export const HIGHLIGHTER_ALPHA = 0.35;
export const POINT_FLUSH_MS = 40;
export const POINT_FLUSH_COUNT = 6;
export const MAX_PACKET_BYTES = 14_000;
export const MAX_POINTS_PER_STROKE = 1_200;

export type CssBox = { x: number; y: number; w: number; h: number };

/**
 * Pointer in CSS pixels through an object-fit:contain content rect, into 0–1.
 * Same math as ScreenAnnotator `toLocal` / `measureContent`. No devicePixelRatio:
 * the website normalises CSS pixels, and the student SVG stretches 0–1 over the
 * video content box. An empty rect returns null so a stroke is not mapped onto
 * the whole tile before the video's intrinsic size is known.
 */
export function pointInContent(pointerCss: { x: number; y: number }, content: CssBox): Pt | null {
  if (!(content.w > 0) || !(content.h > 0)) return null;
  return quantize([(pointerCss.x - content.x) / content.w, (pointerCss.y - content.y) / content.h]);
}

/** object-fit:contain box of a video inside a frame. All values are CSS pixels. */
export function containContentRect(
  frame: CssBox,
  videoBox: CssBox,
  videoWidth: number,
  videoHeight: number
): CssBox {
  if (!(frame.w > 0) || !(frame.h > 0) || !(videoWidth > 0) || !(videoHeight > 0) || !(videoBox.w > 0) || !(videoBox.h > 0)) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  const scale = Math.min(videoBox.w / videoWidth, videoBox.h / videoHeight);
  const dw = videoWidth * scale;
  const dh = videoHeight * scale;
  return {
    x: videoBox.x - frame.x + (videoBox.w - dw) / 2,
    y: videoBox.y - frame.y + (videoBox.h - dh) / 2,
    w: dw,
    h: dh,
  };
}

/**
 * A screen DIP point into a shared surface (a whole monitor or a dragged region).
 * The origin may be negative when the monitor sits left of the primary.
 */
export function pointOnSurface(dip: { x: number; y: number }, surface: CssBox): Pt | null {
  return pointInContent(dip, surface);
}

/** Client pixel inside a window whose outer origin is `windowOriginDip` (DIP). */
export function clientToDip(
  client: { x: number; y: number },
  windowOriginDip: { x: number; y: number }
): { x: number; y: number } {
  return { x: windowOriginDip.x + client.x, y: windowOriginDip.y + client.y };
}

export function packetTooBig(msg: AnnotateMsg): boolean {
  return new TextEncoder().encode(JSON.stringify(msg)).byteLength > MAX_PACKET_BYTES;
}

/**
 * Batches pointer samples the way the website does: one `points` packet every
 * 6 samples or on flush, skipping a sample that duplicates the previous one.
 */
export class AnnotatePointBatch {
  private id: string | null = null;
  private pts: Pt[] = [];
  private last: Pt | null = null;
  constructor(private from: string) {}
  setFrom(from: string): void {
    this.from = from;
  }
  /** Remember the point already sent in `begin`, so the next move does not repeat it. */
  seed(p: Pt): void {
    this.last = quantize(p);
  }
  reset(): void {
    this.id = null;
    this.pts = [];
    this.last = null;
  }
  add(id: string, p: Pt): AnnotateMsg | null {
    const q = quantize(p);
    if (this.last && this.last[0] === q[0] && this.last[1] === q[1]) return null;
    let flushed: AnnotateMsg | null = null;
    if (this.id && this.id !== id && this.pts.length) flushed = this.flush();
    this.id = id;
    this.pts.push(q);
    this.last = q;
    if (this.pts.length >= POINT_FLUSH_COUNT) return this.flush();
    return flushed;
  }
  flush(): AnnotateMsg | null {
    if (!this.id || this.pts.length === 0) {
      this.pts = [];
      return null;
    }
    const msg: AnnotateMsg = { v: 1, type: 'points', id: this.id, pts: this.pts, from: this.from };
    this.pts = [];
    return msg;
  }
}

export function quantize(p: Pt): Pt {
  const q = (n: number) => Math.round((n < 0 ? 0 : n > 1 ? 1 : n) * 10_000) / 10_000;
  return [q(p[0]), q(p[1])];
}

export function distToSegment(p: Pt, a: Pt, b: Pt, aspect = 1): number {
  const px = p[0] * aspect;
  const ax = a[0] * aspect;
  const bx = b[0] * aspect;
  const dx = bx - ax;
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx - px;
  const cy = a[1] + t * dy - p[1];
  return Math.sqrt(cx * cx + cy * cy);
}

export function strokeHit(s: StrokeLike, p: Pt, aspect = 1): boolean {
  const tol = Math.max(0.012, s.width / 900);
  const pts = s.points;
  if (!pts.length) return false;
  if (pts.length === 1) return distToSegment(p, pts[0]!, pts[0]!, aspect) <= tol;
  for (let i = 1; i < pts.length; i++) {
    if (distToSegment(p, pts[i - 1]!, pts[i]!, aspect) <= tol) return true;
  }
  return false;
}

export function mergeSnapshot<T extends StrokeLike>(
  snapshot: T[],
  live: T[],
  erased: ReadonlySet<string> = new Set()
): T[] {
  const liveById = new Map(live.map((s) => [s.id, s]));
  const out: T[] = [];
  const seen = new Set<string>();
  for (const s of snapshot) {
    if (erased.has(s.id) || seen.has(s.id)) continue;
    const l = liveById.get(s.id);
    out.push(l && l.points.length > s.points.length ? l : s);
    seen.add(s.id);
  }
  for (const s of live) if (!seen.has(s.id) && !erased.has(s.id)) out.push(s);
  return out;
}

export function fitSnapshot<T>(strokes: T[], budget = SNAPSHOT_BUDGET_BYTES): T[] {
  let list = strokes;
  const size = (l: T[]) => JSON.stringify({ strokes: l }).length;
  if (size(list) <= budget) return list;
  let lo = 1;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (size(list.slice(mid)) <= budget) hi = mid;
    else lo = mid + 1;
  }
  return list.slice(lo);
}

/** Apply one local drawing op. Returns the next stroke list. */
export function applyAnnotateOp(strokes: AnnotateStroke[], msg: AnnotateMsg): AnnotateStroke[] {
  if (msg.type === 'begin') {
    if (strokes.some((s) => s.id === msg.stroke.id)) return strokes;
    return [...strokes, { ...msg.stroke, points: msg.stroke.points.map((p) => quantize(p)) }];
  }
  if (msg.type === 'point' || msg.type === 'points') {
    const pts = msg.type === 'point' ? [msg.p] : msg.pts;
    return strokes.map((s) =>
      s.id === msg.id ? { ...s, points: [...s.points, ...pts.map((p) => quantize(p))] } : s
    );
  }
  if (msg.type === 'erase') {
    const drop = new Set(msg.ids);
    return strokes.filter((s) => !drop.has(s.id));
  }
  if (msg.type === 'clear') return [];
  if (msg.type === 'undo') return strokes.filter((s) => s.id !== msg.id);
  if (msg.type === 'snapshot') return mergeSnapshot(msg.strokes, strokes);
  return strokes;
}

export function newStrokeId(now = Date.now()): string {
  return `s${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

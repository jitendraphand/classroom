/**
 * Teacher marks on a shared picture (in-tab preview and the students' stage).
 * Not an OS overlay: strokes are normalised 0..1 of the video content box,
 * same frame as student drawing. Pure rules; the provider publishes them.
 */

export const TINK_TOPIC = 'tink';

export type InkKind = 'pen' | 'hl' | 'line' | 'arrow' | 'rect' | 'ellipse';

export type InkStroke = {
  id: string;
  kind: InkKind;
  color: string;
  width: number;
  pts: number[];
};

export type InkMsg =
  | { v: 1; t: 'up'; stroke: InkStroke }
  | { v: 1; t: 'del'; id: string }
  | { v: 1; t: 'clear' }
  | { v: 1; t: 'snap'; strokes: InkStroke[] };

const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^[A-Za-z0-9_-]{4,40}$/;
const KINDS: readonly InkKind[] = ['pen', 'hl', 'line', 'arrow', 'rect', 'ellipse'];

export function validInkStroke(s: unknown): s is InkStroke {
  if (!s || typeof s !== 'object') return false;
  const o = s as InkStroke;
  if (typeof o.id !== 'string' || !ID.test(o.id)) return false;
  if (!KINDS.includes(o.kind)) return false;
  if (typeof o.color !== 'string' || !HEX.test(o.color)) return false;
  if (typeof o.width !== 'number' || !(o.width > 0) || o.width > 80) return false;
  if (!Array.isArray(o.pts) || o.pts.length < 2 || o.pts.length > 4000 || o.pts.length % 2 !== 0) return false;
  return o.pts.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= -0.05 && n <= 1.05);
}

export function decodeInk(raw: unknown): InkMsg | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { v?: unknown; t?: unknown; stroke?: unknown; id?: unknown; strokes?: unknown };
  if (o.v !== 1) return null;
  if (o.t === 'clear') return { v: 1, t: 'clear' };
  if (o.t === 'del' && typeof o.id === 'string' && ID.test(o.id)) return { v: 1, t: 'del', id: o.id };
  if (o.t === 'up' && validInkStroke(o.stroke)) return { v: 1, t: 'up', stroke: o.stroke };
  if (o.t === 'snap' && Array.isArray(o.strokes)) {
    return { v: 1, t: 'snap', strokes: o.strokes.filter(validInkStroke).slice(0, 400) };
  }
  return null;
}

export function applyInk(strokes: readonly InkStroke[], msg: InkMsg): InkStroke[] {
  if (msg.t === 'clear') return [];
  if (msg.t === 'snap') return msg.strokes.map((s) => ({ ...s, pts: s.pts.slice() }));
  if (msg.t === 'del') return strokes.filter((s) => s.id !== msg.id);
  const stroke = { ...msg.stroke, pts: msg.stroke.pts.slice() };
  const i = strokes.findIndex((s) => s.id === stroke.id);
  if (i < 0) return [...strokes, stroke];
  const next = strokes.slice();
  next[i] = stroke;
  return next;
}

/** Closed shape (rect / ellipse outline) or a single segment (line / arrow). */
export function shapePts(kind: InkKind, x0: number, y0: number, x1: number, y1: number): number[] {
  if (kind === 'rect' || kind === 'ellipse') return [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];
  return [x0, y0, x1, y1];
}

/** Arrow head in the same 0..1 space, as a polyline through the tip. */
export function arrowHead(x0: number, y0: number, x1: number, y1: number, size = 0.035): number[] {
  const ang = Math.atan2(y1 - y0, x1 - x0);
  const a1 = ang + Math.PI * 0.8;
  const a2 = ang - Math.PI * 0.8;
  return [x1 + Math.cos(a1) * size, y1 + Math.sin(a1) * size, x1, y1, x1 + Math.cos(a2) * size, y1 + Math.sin(a2) * size];
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number, ar: number) {
  const X = (v: number) => v * ar;
  const dx = X(bx) - X(ax);
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((X(px) - X(ax)) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = X(ax) + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(X(px) - cx, py - cy);
}

/** Newest stroke whose outline passes near the point. `ar` is picture width / height. */
export function hitAnyPts(
  items: readonly { id: string; pts: number[] }[],
  x: number,
  y: number,
  tol = 0.03,
  ar = 16 / 9
): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const s = items[i]!;
    const p = s.pts;
    if (p.length < 2) continue;
    if (p.length === 2) {
      if (Math.hypot((p[0]! - x) * ar, p[1]! - y) <= tol) return s.id;
      continue;
    }
    for (let k = 0; k + 3 < p.length; k += 2) {
      if (segDist(x, y, p[k]!, p[k + 1]!, p[k + 2]!, p[k + 3]!, ar) <= tol) return s.id;
    }
  }
  return null;
}

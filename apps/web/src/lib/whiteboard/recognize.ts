/**
 * Hold-to-snap shape recognition (pure, unit-tested; the Android app ports it
 * line by line). Draw a rough line, box, circle or triangle and keep the pen
 * still at the end: the stroke is replaced by the clean shape. Anything that
 * is not clearly one of those stays a free-hand stroke.
 */
import type { ShapeKind } from './model';

export type SnapShape = { k: ShapeKind; x1: number; y1: number; x2: number; y2: number };

/** Hold still this long at the end of a stroke to snap it. */
export const SNAP_HOLD_MS = 500;
/** "Still" = the pen moved less than this many page units while holding. */
export const SNAP_STILL_PX = 6;

type P = { x: number; y: number };

const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);

function toPoints(flat: number[]): P[] {
  const out: P[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push({ x: flat[i]!, y: flat[i + 1]! });
  return out;
}

function pathLength(p: P[]): number {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += dist(p[i - 1]!, p[i]!);
  return L;
}

/** `n` points evenly spaced along the path. */
export function resample(p: P[], n: number): P[] {
  const L = pathLength(p);
  if (p.length < 2 || L === 0) return p.slice();
  const step = L / (n - 1);
  const out: P[] = [p[0]!];
  let acc = 0;
  let prev = p[0]!;
  for (let i = 1; i < p.length && out.length < n; i++) {
    const cur = p[i]!;
    let d = dist(prev, cur);
    while (acc + d >= step && out.length < n) {
      const t = (step - acc) / d;
      const q = { x: prev.x + t * (cur.x - prev.x), y: prev.y + t * (cur.y - prev.y) };
      out.push(q);
      prev = q;
      d = dist(prev, cur);
      acc = 0;
    }
    acc += d;
    prev = cur;
  }
  while (out.length < n) out.push(p[p.length - 1]!);
  return out;
}

/** Indices of sharp turns (> 50°) along an evenly resampled closed path. */
function corners(r: P[]): number[] {
  const n = r.length;
  const k = 4; // look this many samples back and ahead
  const turn: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = r[(i - k + n) % n]!, b = r[i]!, c = r[(i + k) % n]!;
    const a1 = Math.atan2(b.y - a.y, b.x - a.x), a2 = Math.atan2(c.y - b.y, c.x - b.x);
    let d = Math.abs(a2 - a1);
    if (d > Math.PI) d = 2 * Math.PI - d;
    turn.push(d);
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (turn[i]! < (50 * Math.PI) / 180) continue;
    // Local maximum only (one corner per turn).
    let best = true;
    for (let j = -k; j <= k && best; j++) if (j && turn[(i + j + n) % n]! > turn[i]!) best = false;
    if (best && !out.some((o) => Math.min(Math.abs(o - i), n - Math.abs(o - i)) <= k)) out.push(i);
  }
  return out;
}

/** Snap a line to 0°, 45° or 90° when it is within 6° of it. */
function snapAngle(a: P, b: P): P {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const len = dist(a, b);
  const step = Math.PI / 4;
  const near = Math.round(ang / step) * step;
  if (Math.abs(ang - near) > (6 * Math.PI) / 180) return b;
  return { x: Math.round(a.x + len * Math.cos(near)), y: Math.round(a.y + len * Math.sin(near)) };
}

/**
 * The clean shape a free-hand stroke stands for, or null. `pts` is the
 * stroke's flat point list in page units.
 */
export function recognizeShape(pts: number[]): SnapShape | null {
  const raw = toPoints(pts);
  if (raw.length < 4) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of raw) {
    x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x);
    y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
  }
  const w = x1 - x0, h = y1 - y0, diag = Math.hypot(w, h);
  if (diag < 40) return null;
  const L = pathLength(raw);
  const start = raw[0]!, end = raw[raw.length - 1]!;
  const R = (v: number) => Math.round(v);

  // Straight line: every point close to the chord between the ends, and no
  // doubling back along it (a scribble is longer than its chord).
  const chord = dist(start, end);
  if (chord > 40 && L / chord < 1.5) {
    let dev = 0;
    const dx = end.x - start.x, dy = end.y - start.y;
    for (const q of raw) dev = Math.max(dev, Math.abs(dy * (q.x - start.x) - dx * (q.y - start.y)) / chord);
    if (dev < 0.06 * chord) {
      const e = snapAngle(start, end);
      return { k: 'line', x1: R(start.x), y1: R(start.y), x2: R(e.x), y2: R(e.y) };
    }
  }
  // Closed shapes only from here: the stroke ends near where it began.
  if (dist(start, end) > Math.max(0.2 * diag, 30)) return null;
  const r = resample(raw, 64);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.max(1, w / 2), ry = Math.max(1, h / 2);

  const cs = corners(r);
  // Rectangle: four corners and every point near the box's edges.
  if (cs.length === 4) {
    let off = 0;
    for (const q of r) off += Math.min(Math.abs(q.x - x0), Math.abs(q.x - x1), Math.abs(q.y - y0), Math.abs(q.y - y1));
    if (off / r.length / diag < 0.06) return { k: 'rect', x1: R(x0), y1: R(y0), x2: R(x1), y2: R(y1) };
  }
  // Triangle with its apex near the top centre (the board's triangle shape).
  if (cs.length === 3) {
    const pts3 = cs.map((i) => r[i]!).sort((a, b) => a.y - b.y);
    const apex = pts3[0]!, base = pts3.slice(1);
    const apexCentred = Math.abs(apex.x - cx) < 0.2 * w && apex.y - y0 < 0.15 * h;
    const baseLow = base.every((q) => y1 - q.y < 0.15 * h);
    if (apexCentred && baseLow) return { k: 'tri', x1: R(x0), y1: R(y0), x2: R(x1), y2: R(y1) };
  }
  // Ellipse: every point near the ellipse that fits the box (a long thin one
  // shows its two pointed ends as corners); a near-circle becomes a circle.
  if (cs.length <= 2) {
    let dev = 0;
    for (const q of r) dev += Math.abs(Math.hypot((q.x - cx) / rx, (q.y - cy) / ry) - 1);
    if (dev / r.length < 0.16) {
      if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.15) {
        const m = (rx + ry) / 2;
        return { k: 'ellipse', x1: R(cx - m), y1: R(cy - m), x2: R(cx + m), y2: R(cy + m) };
      }
      return { k: 'ellipse', x1: R(x0), y1: R(y0), x2: R(x1), y2: R(y1) };
    }
  }
  return null;
}

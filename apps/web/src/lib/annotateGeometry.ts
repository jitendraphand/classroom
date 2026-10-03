/**
 * Pure helpers for the screen-share annotation layer (ScreenAnnotator.tsx),
 * unit-tested in tests/annotate.test.ts.
 */

export type Pt = [number, number];
export type StrokeLike = { id: string; width: number; points: Pt[] };

/** Same cap as the PUT /annotate route (MAX_SNAPSHOT_BYTES); a little headroom for the wrapper. */
export const SNAPSHOT_BUDGET_BYTES = 250_000;

/**
 * Normalised coordinates to 4 decimals (0.38 px on a 3840 px wide share).
 * Full double precision made each point ~40 bytes of JSON, so a few scribbles
 * blew the 256 KB snapshot cap and late joiners got no strokes at all.
 */
export function quantize(p: Pt): Pt {
  const q = (n: number) => Math.round((n < 0 ? 0 : n > 1 ? 1 : n) * 10_000) / 10_000;
  return [q(p[0]), q(p[1])];
}

/** Distance from p to segment ab, in an aspect-corrected space (x scaled by `aspect` = w/h). */
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

/**
 * Does the eraser at p touch this stroke? Tests every segment, not only the
 * recorded vertices: a quick straight line has 2–3 points, so a vertex-only
 * test could not erase it anywhere in the middle.
 */
export function strokeHit(s: StrokeLike, p: Pt, aspect = 1): boolean {
  const tol = Math.max(0.012, s.width / 900);
  const pts = s.points;
  if (pts.length === 1) return distToSegment(p, pts[0]!, pts[0]!, aspect) <= tol;
  for (let i = 1; i < pts.length; i++) {
    if (distToSegment(p, pts[i - 1]!, pts[i]!, aspect) <= tol) return true;
  }
  return false;
}

/**
 * Combine the durable snapshot with strokes that arrived live while it was
 * loading. The old code threw the snapshot away whenever any live packet
 * landed during the fetch, so a student joining while the teacher drew saw
 * only the newest strokes. Order follows the snapshot; for a stroke in both,
 * the copy with more points wins; live-only strokes are appended.
 */
export function mergeSnapshot<T extends StrokeLike>(snapshot: T[], live: T[], erased: ReadonlySet<string> = new Set()): T[] {
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

/** Drop the oldest strokes until the JSON body fits the snapshot budget. */
export function fitSnapshot<T>(strokes: T[], budget = SNAPSHOT_BUDGET_BYTES): T[] {
  let list = strokes;
  const size = (l: T[]) => JSON.stringify({ strokes: l }).length;
  if (size(list) <= budget) return list;
  // Binary search the number of oldest strokes to drop.
  let lo = 1;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (size(list.slice(mid)) <= budget) hi = mid;
    else lo = mid + 1;
  }
  list = list.slice(lo);
  return list;
}

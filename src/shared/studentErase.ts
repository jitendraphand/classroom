/**
 * Teacher eraser over student desktop ink. Student strokes are 0..1 of the
 * shared picture; `rect` places the picture on the monitor (region shares),
 * the eraser point is 0..1 of the monitor. A hit removes the whole stroke
 * (per-stroke, like the teacher's own eraser) for every viewer via the
 * server (`POST /draw {action:'erase'}` → `del` packet).
 */
import { strokeHit, type Pt } from './annotate';

export type InkRect = { x: number; y: number; w: number; h: number };
export type StudentStrokeLike = { id: string; pts: number[] };

export function studentStrokesHit(strokes: readonly StudentStrokeLike[], rect: InkRect, p: Pt, aspect = 1): string[] {
  if (!(rect.w > 0) || !(rect.h > 0)) return [];
  const out: string[] = [];
  for (const s of strokes) {
    const points: Pt[] = [];
    for (let i = 0; i + 1 < s.pts.length; i += 2) points.push([rect.x + s.pts[i]! * rect.w, rect.y + s.pts[i + 1]! * rect.h]);
    if (strokeHit({ id: s.id, width: 0, points }, p, aspect)) out.push(s.id);
  }
  return out;
}

/** Remove erased ids locally right away (the server `del` echo is idempotent). */
export function withoutStrokes<T extends { id: string }>(strokes: readonly T[], ids: readonly string[]): T[] {
  if (!ids.length) return strokes.slice();
  const drop = new Set(ids);
  return strokes.filter((s) => !drop.has(s.id));
}

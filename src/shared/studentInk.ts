/**
 * Student desktop ink, pure path: the server's `draw` data packet (bytes) →
 * stroke list → points on the teacher's overlay canvas. Used by the class
 * window (packets) and the overlay (drawStudentInk), and covered end to end
 * by tests/studentInk.test.ts (trial 2026-10-14 could not prove that student
 * strokes reach the teacher overlay).
 */
import { applyPacket, decodePacket, type Stroke } from './web/drawLogic';

export type InkRect = { x: number; y: number; w: number; h: number };

/** One LiveKit `draw` payload (server-originated, JSON) applied to the strokes. Malformed → unchanged. */
export function applyDrawBytes(strokes: Stroke[], payload: Uint8Array): { strokes: Stroke[]; changed: boolean; kind: string | null } {
  try {
    const p = decodePacket(JSON.parse(new TextDecoder().decode(payload)));
    if (!p) return { strokes, changed: false, kind: null };
    return { strokes: applyPacket(strokes, p), changed: true, kind: p.t };
  } catch {
    return { strokes, changed: false, kind: null };
  }
}

/** 0..1 of the shared picture → the picture's place on the overlay (`rect`, 0..1) → canvas pixels. */
export function inkPoint(x: number, y: number, rect: InkRect, canvasW: number, canvasH: number): { x: number; y: number } {
  return { x: (rect.x + x * rect.w) * canvasW, y: (rect.y + y * rect.h) * canvasH };
}

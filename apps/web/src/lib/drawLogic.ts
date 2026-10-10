/**
 * Student drawing on the teacher's shared screen — pure rules, shared by the
 * server (/api/rooms/[code]/draw) and every client, unit-tested in
 * tests/draw.test.ts.
 *
 * How it works:
 * - A student taps "Request to draw" (like a raised hand). The teacher allows
 *   ONE student at a time (roster / share-controls roster); the allow lasts
 *   DRAW_ALLOW_MS, or until the teacher revokes it, the student stops, or the
 *   share stops.
 * - The allowed student draws freehand on THEIR view of the share. Points are
 *   normalised to the shared picture (0..1 of the video content box, not of
 *   the element, so letterboxing on any screen shape lands in the same spot)
 *   and posted in small batches (~12/s) to the server, which checks the
 *   holder, stores them in Redis and relays them to everyone as a LiveKit
 *   data packet on topic `draw`. Only the server sends that topic: clients
 *   ignore a `draw` packet that names a participant, so students never get a
 *   data-publish grant.
 * - Everyone (teacher in-page preview, share-controls Drawing panel, every
 *   student's share view, admin observers) renders the same strokes as an
 *   overlay over the video. Nothing is drawn on the teacher's real desktop and
 *   no input reaches the teacher's computer.
 * - Late joiners load the current strokes with GET /draw. `pts` packets carry
 *   the index they start at, so a packet that overlaps the loaded snapshot is
 *   applied idempotently.
 * - Desktop ink (Windows teacher app, state `desktopInk`): the app draws the
 *   strokes on the teacher's real desktop in a captured overlay, so they are
 *   already in the shared video. Viewers then draw no overlay (it would show
 *   twice, slightly offset in time); the drawing student keeps only the
 *   stroke under the pen plus a short fade (DESKTOP_INK_FADE_MS) to cover the
 *   share's latency. See desktopInkShown.
 */

export const DRAW_TOPIC = 'draw';
/** How long an allow lasts (the teacher can allow again to extend). */
export const DRAW_ALLOW_MS = 3 * 60 * 1000;
/** Client batching interval for points (~12 batches per second). */
export const DRAW_SEND_MS = 80;
export const MAX_STROKES = 400;
/** Points per stroke (x,y pairs). Longer strokes are split by the client. */
export const MAX_STROKE_POINTS = 1200;
/** Points per POST batch. */
export const MAX_BATCH_POINTS = 200;

export const DRAW_COLORS = {
  red: '#ef4444',
  yellow: '#facc15',
  blue: '#3b82f6',
} as const;
export type DrawColor = keyof typeof DRAW_COLORS;
export const DRAW_COLOR_NAMES = Object.keys(DRAW_COLORS) as DrawColor[];

export function isDrawColor(c: unknown): c is DrawColor {
  return typeof c === 'string' && c in DRAW_COLORS;
}

export type Stroke = {
  id: string;
  /** LiveKit identity of the student who drew it. */
  by: string;
  name: string;
  color: DrawColor;
  /** Flat [x0, y0, x1, y1, …], each 0..1 of the shared picture. */
  pts: number[];
};

export type DrawHolder = {
  participantId: string;
  identity: string;
  name: string;
  /** ms epoch when the allow ends. */
  until: number;
};

/** Server → clients (topic `draw`). */
export type DrawPacket =
  /** `from`: index in the flat pts array where these values start. */
  | { v: 1; t: 'pts'; id: string; by: string; name: string; c: DrawColor; from: number; pts: number[] }
  | { v: 1; t: 'del'; id: string }
  | { v: 1; t: 'clear' };

export function holderActive(h: DrawHolder | null | undefined, now = Date.now()): h is DrawHolder {
  return !!h && h.until > now;
}

const ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
export function validStrokeId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

/** Round to 4 decimals (≈0.2px on a 2K screen) and clamp into the picture. */
export function q(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;
}

/** Validate + normalise a flat point list from a client. Null when unusable. */
export function cleanPoints(raw: unknown, max = MAX_BATCH_POINTS): number[] | null {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length % 2 !== 0 || raw.length > max * 2) return null;
  const out: number[] = [];
  for (const v of raw) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < -0.01 || v > 1.01) return null;
    out.push(q(v));
  }
  return out;
}

/**
 * The box the video picture occupies inside its element with
 * `object-fit: contain` (letterbox / pillarbox).
 */
export function containRect(elW: number, elH: number, vidW: number, vidH: number) {
  if (!(elW > 0 && elH > 0)) return { x: 0, y: 0, w: 0, h: 0 };
  if (!(vidW > 0 && vidH > 0)) return { x: 0, y: 0, w: elW, h: elH };
  const s = Math.min(elW / vidW, elH / vidH);
  const w = vidW * s;
  const h = vidH * s;
  return { x: (elW - w) / 2, y: (elH - h) / 2, w, h };
}

/** Pointer position (relative to the element) → normalised picture coords. */
export function toNorm(px: number, py: number, rect: { x: number; y: number; w: number; h: number }): [number, number] {
  if (!(rect.w > 0 && rect.h > 0)) return [0, 0];
  return [q((px - rect.x) / rect.w), q((py - rect.y) / rect.h)];
}

/** Stroke width in px for a picture of this width (same look on every screen). */
export function strokeWidthFor(picW: number): number {
  return Math.max(2, Math.min(8, picW * 0.004));
}

/** Server/stored state ← packet. Returns a new array (immutable). */
export function applyPacket(strokes: Stroke[], p: DrawPacket): Stroke[] {
  if (p.t === 'clear') return [];
  if (p.t === 'del') return strokes.filter((s) => s.id !== p.id);
  const i = strokes.findIndex((s) => s.id === p.id);
  if (i < 0) {
    if (strokes.length >= MAX_STROKES) return strokes;
    return [...strokes, { id: p.id, by: p.by, name: p.name, color: p.c, pts: p.pts.slice(0, MAX_STROKE_POINTS * 2) }];
  }
  const cur = strokes[i]!;
  // Idempotent append: cut at `from`, then add (a snapshot may already hold some).
  const start = Math.min(cur.pts.length, Math.max(0, p.from));
  const pts = [...cur.pts.slice(0, start), ...p.pts].slice(0, MAX_STROKE_POINTS * 2);
  const next = strokes.slice();
  next[i] = { ...cur, pts };
  return next;
}

/** Parse a `draw` data packet; null for anything malformed. */
export function decodePacket(raw: unknown): DrawPacket | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (p.v !== 1) return null;
  if (p.t === 'clear') return { v: 1, t: 'clear' };
  if (p.t === 'del' && validStrokeId(p.id)) return { v: 1, t: 'del', id: p.id };
  if (p.t === 'pts' && validStrokeId(p.id) && typeof p.by === 'string' && typeof p.name === 'string' && isDrawColor(p.c)) {
    const pts = cleanPoints(p.pts, MAX_STROKE_POINTS);
    const from = typeof p.from === 'number' && Number.isInteger(p.from) && p.from >= 0 ? p.from : 0;
    if (!pts) return null;
    return { v: 1, t: 'pts', id: p.id, by: p.by, name: p.name.slice(0, 80), c: p.c, from, pts };
  }
  return null;
}

/** Distance from point to segment (normalised units, aspect-corrected by `ar` = w/h). */
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

/**
 * Eraser: the newest stroke by `by` passing within `tol` (fraction of the
 * picture height) of the point. Students can only erase their own strokes.
 */
export function hitStroke(strokes: Stroke[], by: string, x: number, y: number, tol = 0.02, ar = 16 / 9): string | null {
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i]!;
    if (s.by !== by) continue;
    const p = s.pts;
    if (p.length === 2 && Math.hypot((p[0]! - x) * ar, p[1]! - y) <= tol) return s.id;
    for (let k = 0; k + 3 < p.length; k += 2) {
      if (segDist(x, y, p[k]!, p[k + 1]!, p[k + 2]!, p[k + 3]!, ar) <= tol) return s.id;
    }
  }
  return null;
}

/** Undo: the drawer's newest stroke. */
export function lastStrokeOf(strokes: Stroke[], by: string): string | null {
  for (let i = strokes.length - 1; i >= 0; i--) if (strokes[i]!.by === by) return strokes[i]!.id;
  return null;
}

/**
 * Where to show each drawer's name: at the end of their newest stroke.
 */
export function nameTags(strokes: Stroke[]): { by: string; name: string; color: DrawColor; x: number; y: number }[] {
  const seen = new Map<string, { by: string; name: string; color: DrawColor; x: number; y: number }>();
  for (const s of strokes) {
    if (s.pts.length < 2) continue;
    seen.set(s.by, { by: s.by, name: s.name, color: s.color, x: s.pts[s.pts.length - 2]!, y: s.pts[s.pts.length - 1]! });
  }
  return [...seen.values()];
}

/**
 * Client batching: collect points and flush at most every `intervalMs`, one
 * request in flight at a time (so batches reach the server in order).
 */
export function createPointBatcher(
  send: (batch: { id: string; from: number; pts: number[]; color: DrawColor }) => Promise<unknown>,
  intervalMs = DRAW_SEND_MS,
  schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms)
) {
  let queue: { id: string; color: DrawColor; from: number; pts: number[] }[] = [];
  const sent = new Map<string, number>();
  let inFlight = false;
  let timer = false;
  const flush = async (): Promise<void> => {
    timer = false;
    if (inFlight || !queue.length) return;
    const item = queue.shift()!;
    inFlight = true;
    try {
      await send(item);
    } catch {
      /* dropped: the stroke continues from the next point */
    }
    inFlight = false;
    if (queue.length) arm();
  };
  const arm = () => {
    if (timer) return;
    timer = true;
    schedule(() => void flush(), intervalMs);
  };
  return {
    /** Add points (flat x,y) to stroke `id`. */
    add(id: string, color: DrawColor, pts: number[]) {
      const last = queue[queue.length - 1];
      // Queued items are never in flight (flush shifts before sending), so
      // merging into the tail keeps `from` correct.
      if (last && last.id === id && last.pts.length / 2 < MAX_BATCH_POINTS) {
        last.pts.push(...pts);
      } else {
        queue.push({ id, color, from: sent.get(id) ?? 0, pts: [...pts] });
      }
      sent.set(id, (sent.get(id) ?? 0) + pts.length);
      arm();
    },
    pending: () => queue.length + (inFlight ? 1 : 0),
    flushNow: flush,
  };
}

/**
 * Desktop ink: how long the drawer keeps a local copy after the last point.
 * The Windows app composites the stroke into the shared video within ~66 ms
 * plus the share's latency (~150-400 ms), so 500 ms covers it while keeping
 * the overlap (stroke seen twice) short. While the pen moves the local copy
 * is always shown: zero-latency feedback under the pen.
 */
export const DESKTOP_INK_FADE_MS = 500;

/**
 * Strokes to draw locally. Normal shares: all of them. Desktop ink: only my
 * own strokes touched in the last DESKTOP_INK_FADE_MS (`touched`: stroke id
 * -> ms of its last local point); everything else is already in the video.
 */
export function desktopInkShown(
  strokes: Stroke[],
  opts: { desktopInk: boolean; me: string; touched: ReadonlyMap<string, number>; now: number }
): Stroke[] {
  if (!opts.desktopInk) return strokes;
  return strokes.filter((s) => {
    if (s.by !== opts.me) return false;
    const t = opts.touched.get(s.id);
    return t !== undefined && opts.now - t < DESKTOP_INK_FADE_MS;
  });
}

/**
 * Whiteboard document model + protocol (shared by the web app and the Windows
 * teacher app; the Windows copy lives in src/shared/web/whiteboard and is
 * synced with scripts/sync-whiteboard.sh). No DOM, no React: unit-tested.
 *
 * Transport is NOT video: the teacher sends small vector ops over LiveKit
 * data channels (reliable, topic `wb`), batched (~30 ms of pen points per
 * packet) and only when something changes. Late joiners / rejoiners ask for a
 * snapshot (compressed, see codec.ts). Coordinates are integers on a fixed
 * logical page of PAGE_W x PAGE_H, so every device renders the same picture,
 * scaled to its viewport.
 */

export const WB_TOPIC = 'wb';
export const PAGE_W = 1920;
export const PAGE_H = 1080;
export const MAX_PAGES = 50;
export const MAX_ITEMS_PER_PAGE = 4000;
export const MAX_POINTS_PER_STROKE = 4000; // x,y pairs
/** Pen points are flushed this often while drawing. */
export const BATCH_MS = 30;

export type Background = 'white' | 'grid' | 'lined' | 'black';
export const BACKGROUNDS: Background[] = ['white', 'grid', 'lined', 'black'];

export type StrokeItem = {
  k: 'stroke';
  id: string;
  by: string;
  tool: 'pen' | 'hl';
  c: string;
  w: number;
  /** Flat [x0,y0,x1,y1,...] integers in page units. */
  pts: number[];
};
export type ShapeItem = {
  k: 'line' | 'arrow' | 'rect' | 'ellipse';
  id: string;
  by: string;
  c: string;
  w: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};
export type TextItem = { k: 'text'; id: string; by: string; c: string; size: number; x: number; y: number; text: string };
export type ImageItem = { k: 'img'; id: string; by: string; x: number; y: number; w: number; h: number; src: string };
export type Item = StrokeItem | ShapeItem | TextItem | ImageItem;

export type Page = { id: string; bg: Background; items: Item[] };
export type Doc = { v: 1; pages: Page[]; cur: number };

export type Op =
  | { k: 'add'; p: string; item: Item }
  | { k: 'pts'; p: string; id: string; pts: number[] }
  | { k: 'del'; p: string; ids: string[] }
  | { k: 'clear'; p: string }
  | { k: 'bg'; p: string; bg: Background }
  | { k: 'newpage'; at: number; id: string; bg: Background }
  | { k: 'delpage'; p: string }
  | { k: 'go'; cur: number }
  | { k: 'delBy'; by: string };

/** Packets on the `wb` topic. */
export type Packet =
  | { v: 1; t: 'ops'; ops: Op[]; by?: string }
  | { v: 1; t: 'snap'; doc: string; z: 0 | 1 }
  | { v: 1; t: 'chunk'; id: string; i: number; n: number; d: string }
  | { v: 1; t: 'req'; to: string }
  | { v: 1; t: 'end' };

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function newId(prefix = ''): string {
  const r = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  return (prefix + r).slice(0, 40);
}

export function emptyDoc(bg: Background = 'white'): Doc {
  return { v: 1, pages: [{ id: newId('p'), bg, items: [] }], cur: 0 };
}

export function currentPage(doc: Doc): Page {
  return doc.pages[Math.min(Math.max(0, doc.cur), doc.pages.length - 1)]!;
}

const clampN = (n: unknown, lo: number, hi: number) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
};

function cleanPts(raw: unknown, max = MAX_POINTS_PER_STROKE * 2): number[] | null {
  if (!Array.isArray(raw)) return null;
  const out: number[] = [];
  for (let i = 0; i + 1 < raw.length && out.length < max; i += 2) {
    out.push(clampN(raw[i], -PAGE_W, PAGE_W * 2), clampN(raw[i + 1], -PAGE_H, PAGE_H * 2));
  }
  return out;
}

/** Validate/normalise an item from the network. Null = reject. */
export function cleanItem(raw: unknown): Item | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = String(o.id ?? '');
  const by = String(o.by ?? '').slice(0, 80);
  if (!ID_RE.test(id)) return null;
  const c = COLOR_RE.test(String(o.c)) ? String(o.c) : '#111111';
  switch (o.k) {
    case 'stroke': {
      const pts = cleanPts(o.pts);
      if (!pts) return null;
      return { k: 'stroke', id, by, tool: o.tool === 'hl' ? 'hl' : 'pen', c, w: clampN(o.w, 1, 80), pts };
    }
    case 'line':
    case 'arrow':
    case 'rect':
    case 'ellipse':
      return {
        k: o.k,
        id,
        by,
        c,
        w: clampN(o.w, 1, 80),
        x1: clampN(o.x1, -PAGE_W, PAGE_W * 2),
        y1: clampN(o.y1, -PAGE_H, PAGE_H * 2),
        x2: clampN(o.x2, -PAGE_W, PAGE_W * 2),
        y2: clampN(o.y2, -PAGE_H, PAGE_H * 2),
      };
    case 'text': {
      const text = String(o.text ?? '').slice(0, 2000);
      if (!text) return null;
      return { k: 'text', id, by, c, size: clampN(o.size, 8, 400), x: clampN(o.x, -PAGE_W, PAGE_W * 2), y: clampN(o.y, -PAGE_H, PAGE_H * 2), text };
    }
    case 'img': {
      const src = String(o.src ?? '');
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(src) || src.length > 3_000_000) return null;
      return {
        k: 'img',
        id,
        by,
        src,
        x: clampN(o.x, -PAGE_W, PAGE_W * 2),
        y: clampN(o.y, -PAGE_H, PAGE_H * 2),
        w: clampN(o.w, 1, PAGE_W * 3),
        h: clampN(o.h, 1, PAGE_H * 3),
      };
    }
    default:
      return null;
  }
}

function pageById(doc: Doc, id: string): Page | undefined {
  return doc.pages.find((p) => p.id === id);
}

/**
 * Apply one op in place. Unknown pages/items are ignored (idempotent enough
 * for a snapshot racing with live ops). Returns true when something changed.
 */
export function applyOp(doc: Doc, op: Op): boolean {
  switch (op.k) {
    case 'add': {
      const page = pageById(doc, op.p);
      const item = cleanItem(op.item);
      if (!page || !item) return false;
      const i = page.items.findIndex((x) => x.id === item.id);
      if (i >= 0) page.items[i] = item;
      else if (page.items.length < MAX_ITEMS_PER_PAGE) page.items.push(item);
      else return false;
      return true;
    }
    case 'pts': {
      const page = pageById(doc, op.p);
      const s = page?.items.find((x) => x.id === op.id);
      if (!s || s.k !== 'stroke') return false;
      const pts = cleanPts(op.pts, Math.max(0, MAX_POINTS_PER_STROKE * 2 - s.pts.length));
      if (!pts?.length) return false;
      s.pts.push(...pts);
      return true;
    }
    case 'del': {
      const page = pageById(doc, op.p);
      if (!page) return false;
      const ids = new Set(op.ids);
      const before = page.items.length;
      page.items = page.items.filter((x) => !ids.has(x.id));
      return page.items.length !== before;
    }
    case 'clear': {
      const page = pageById(doc, op.p);
      if (!page || !page.items.length) return false;
      page.items = [];
      return true;
    }
    case 'bg': {
      const page = pageById(doc, op.p);
      if (!page || !BACKGROUNDS.includes(op.bg)) return false;
      page.bg = op.bg;
      return true;
    }
    case 'newpage': {
      if (doc.pages.length >= MAX_PAGES || pageById(doc, op.id) || !ID_RE.test(op.id)) return false;
      const at = Math.min(Math.max(0, op.at), doc.pages.length);
      doc.pages.splice(at, 0, { id: op.id, bg: BACKGROUNDS.includes(op.bg) ? op.bg : 'white', items: [] });
      doc.cur = at;
      return true;
    }
    case 'delpage': {
      if (doc.pages.length <= 1) return false;
      const i = doc.pages.findIndex((p) => p.id === op.p);
      if (i < 0) return false;
      doc.pages.splice(i, 1);
      doc.cur = Math.min(doc.cur, doc.pages.length - 1);
      return true;
    }
    case 'go': {
      const cur = Math.min(Math.max(0, Math.floor(op.cur)), doc.pages.length - 1);
      if (cur === doc.cur) return false;
      doc.cur = cur;
      return true;
    }
    case 'delBy': {
      let changed = false;
      for (const p of doc.pages) {
        const n = p.items.length;
        p.items = p.items.filter((x) => x.by !== op.by);
        if (p.items.length !== n) changed = true;
      }
      return changed;
    }
  }
  return false;
}

/** Validate a document received in a snapshot. */
export function cleanDoc(raw: unknown): Doc | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.pages) || !o.pages.length) return null;
  const pages: Page[] = [];
  for (const p of o.pages.slice(0, MAX_PAGES) as Record<string, unknown>[]) {
    const id = String(p?.id ?? '');
    if (!ID_RE.test(id)) continue;
    const bg = BACKGROUNDS.includes(p.bg as Background) ? (p.bg as Background) : 'white';
    const items = (Array.isArray(p.items) ? p.items : []).slice(0, MAX_ITEMS_PER_PAGE).map(cleanItem).filter((x): x is Item => !!x);
    pages.push({ id, bg, items });
  }
  if (!pages.length) return null;
  return { v: 1, pages, cur: clampN(o.cur, 0, pages.length - 1) };
}

/** Ops a student (annotation permission) may send: only their own pen strokes. */
export function studentOpAllowed(op: Op, identity: string, doc?: Doc): boolean {
  if (op.k === 'add') return op.item?.k === 'stroke' && op.item.by === identity;
  if (op.k === 'pts') {
    if (!doc) return true;
    const it = doc.pages.find((p) => p.id === op.p)?.items.find((x) => x.id === op.id);
    return !!it && it.by === identity;
  }
  if (op.k === 'del') {
    if (!doc) return true;
    const page = doc.pages.find((p) => p.id === op.p);
    return !!page && op.ids.every((id) => page.items.find((x) => x.id === id)?.by === identity);
  }
  return false;
}

/** Inverse ops for undo (teacher editor). `before` is the page state before `op`. */
export function inverseOf(op: Op, before: Page | undefined, doc: Doc): Op[] {
  switch (op.k) {
    case 'add':
      return [{ k: 'del', p: op.p, ids: [op.item.id] }];
    case 'del':
    case 'clear': {
      if (!before) return [];
      const ids = op.k === 'del' ? new Set(op.ids) : null;
      return before.items.filter((x) => !ids || ids.has(x.id)).map((item) => ({ k: 'add', p: before.id, item: structuredCloneSafe(item) }));
    }
    case 'bg':
      return before ? [{ k: 'bg', p: op.p, bg: before.bg }] : [];
    case 'newpage':
      return [{ k: 'delpage', p: op.id }];
    case 'go':
      return [{ k: 'go', cur: doc.cur }];
    default:
      return [];
  }
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Point-to-segment distance (page units). */
function segDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function itemBounds(it: Item): { x: number; y: number; w: number; h: number } {
  switch (it.k) {
    case 'stroke': {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i + 1 < it.pts.length; i += 2) {
        x0 = Math.min(x0, it.pts[i]!); x1 = Math.max(x1, it.pts[i]!);
        y0 = Math.min(y0, it.pts[i + 1]!); y1 = Math.max(y1, it.pts[i + 1]!);
      }
      const pad = it.w / 2;
      return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + it.w, h: y1 - y0 + it.w };
    }
    case 'text': {
      const lines = it.text.split('\n');
      const w = Math.max(...lines.map((l) => l.length)) * it.size * 0.55;
      return { x: it.x, y: it.y, w, h: lines.length * it.size * 1.25 };
    }
    case 'img':
      return { x: it.x, y: it.y, w: it.w, h: it.h };
    default:
      return { x: Math.min(it.x1, it.x2) - it.w, y: Math.min(it.y1, it.y2) - it.w, w: Math.abs(it.x2 - it.x1) + 2 * it.w, h: Math.abs(it.y2 - it.y1) + 2 * it.w };
  }
}

/** Does a point (with radius r) touch this item? Used by the stroke eraser. */
export function hitItem(it: Item, x: number, y: number, r: number): boolean {
  switch (it.k) {
    case 'stroke': {
      const tol = r + it.w / 2;
      if (it.pts.length === 2) return Math.hypot(x - it.pts[0]!, y - it.pts[1]!) <= tol;
      for (let i = 0; i + 3 < it.pts.length; i += 2) {
        if (segDist(x, y, it.pts[i]!, it.pts[i + 1]!, it.pts[i + 2]!, it.pts[i + 3]!) <= tol) return true;
      }
      return false;
    }
    case 'line':
    case 'arrow':
      return segDist(x, y, it.x1, it.y1, it.x2, it.y2) <= r + it.w / 2;
    case 'rect': {
      const tol = r + it.w / 2;
      const [a, b, c, d] = [it.x1, it.y1, it.x2, it.y2];
      return segDist(x, y, a, b, c, b) <= tol || segDist(x, y, c, b, c, d) <= tol || segDist(x, y, c, d, a, d) <= tol || segDist(x, y, a, d, a, b) <= tol;
    }
    case 'ellipse': {
      const cx = (it.x1 + it.x2) / 2, cy = (it.y1 + it.y2) / 2;
      const rx = Math.abs(it.x2 - it.x1) / 2 || 1, ry = Math.abs(it.y2 - it.y1) / 2 || 1;
      const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
      return Math.abs(d - 1) * Math.min(rx, ry) <= r + it.w / 2;
    }
    default: {
      const b = itemBounds(it);
      return x >= b.x - r && x <= b.x + b.w + r && y >= b.y - r && y <= b.y + b.h + r;
    }
  }
}

/** Area eraser: items whose bounds intersect the rectangle. */
export function itemsInRect(page: Page, x1: number, y1: number, x2: number, y2: number, filter?: (it: Item) => boolean): string[] {
  const rx = Math.min(x1, x2), ry = Math.min(y1, y2), rw = Math.abs(x2 - x1), rh = Math.abs(y2 - y1);
  return page.items
    .filter((it) => (!filter || filter(it)))
    .filter((it) => {
      const b = itemBounds(it);
      return b.x < rx + rw && b.x + b.w > rx && b.y < ry + rh && b.y + b.h > ry;
    })
    .map((it) => it.id);
}

/**
 * Pen batching: collects points and hands out one `pts` op per flush. The
 * editor calls `push` on every pointer move and `flush` every BATCH_MS.
 */
export class PointBatcher {
  private pending: number[] = [];
  constructor(
    readonly page: string,
    readonly id: string
  ) {}
  push(x: number, y: number) {
    const n = this.pending.length;
    const rx = Math.round(x), ry = Math.round(y);
    if (n >= 2 && this.pending[n - 2] === rx && this.pending[n - 1] === ry) return;
    this.pending.push(rx, ry);
  }
  flush(): Op | null {
    if (!this.pending.length) return null;
    const pts = this.pending;
    this.pending = [];
    return { k: 'pts', p: this.page, id: this.id, pts };
  }
}

/** Split a long string into chunk packets (data-channel packets stay small). */
export const CHUNK_CHARS = 12_000;
export function chunkPackets(payload: string, id = newId('c')): Packet[] {
  if (payload.length <= CHUNK_CHARS) return [JSON.parse(payload) as Packet];
  const n = Math.ceil(payload.length / CHUNK_CHARS);
  const out: Packet[] = [];
  for (let i = 0; i < n; i++) out.push({ v: 1, t: 'chunk', id, i, n, d: payload.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) });
  return out;
}

/** Reassembles chunk packets; returns the full packet when complete. */
export class ChunkAssembler {
  private parts = new Map<string, { n: number; got: string[]; count: number; at: number }>();
  add(p: Extract<Packet, { t: 'chunk' }>, now = Date.now()): Packet | null {
    for (const [k, v] of this.parts) if (now - v.at > 60_000) this.parts.delete(k);
    if (!(p.n > 0 && p.n <= 2000 && p.i >= 0 && p.i < p.n)) return null;
    let e = this.parts.get(p.id);
    if (!e) {
      e = { n: p.n, got: new Array(p.n), count: 0, at: now };
      this.parts.set(p.id, e);
    }
    if (e.got[p.i] === undefined) {
      e.got[p.i] = p.d;
      e.count++;
    }
    if (e.count < e.n) return null;
    this.parts.delete(p.id);
    try {
      return JSON.parse(e.got.join('')) as Packet;
    } catch {
      return null;
    }
  }
}

export function encodePacket(p: Packet): Uint8Array[] {
  return chunkPackets(JSON.stringify(p)).map((x) => new TextEncoder().encode(JSON.stringify(x)));
}

export function decodePacket(bytes: Uint8Array): Packet | null {
  try {
    const p = JSON.parse(new TextDecoder().decode(bytes)) as Packet;
    return p && p.v === 1 && typeof p.t === 'string' ? p : null;
  } catch {
    return null;
  }
}

/** Default pen colour for a background (black ink on light, white on black). */
export function inkFor(bg: Background): string {
  return bg === 'black' ? '#ffffff' : '#111111';
}

export const PALETTE = ['#111111', '#ffffff', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa'];

/**
 * A relayed student packet (`by` = author) that this device itself sent. The
 * author already applied those ops locally; applying the relayed copy again
 * appends the same `pts` twice, so the stroke looked doubled on the drawing
 * student's screen (round 6, item 4). Drop it.
 */
export function isOwnRelayEcho(p: { t?: string; by?: string } | null | undefined, me: string | null | undefined): boolean {
  return !!p && p.t === 'ops' && !!p.by && !!me && p.by === me;
}

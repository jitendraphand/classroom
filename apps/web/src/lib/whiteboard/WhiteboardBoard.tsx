'use client';
/**
 * Whiteboard canvas + tools (React, inline styles only, so the same file runs
 * in the Next.js web app and the Windows Electron renderer; the Android app
 * mirrors the same tools, groups, icons and rendering natively).
 *
 * mode:
 *  - 'edit'     teacher: every tool, selection, laser, pages, background, zoom/pan, image, export
 *  - 'annotate' student allowed to draw: pen colours + erase own strokes
 *  - 'view'     student / admin preview: render only (and the teacher's laser)
 * One long page (Nov 2026): fixed width (PAGE_W) and a fixed top edge; the
 * teacher scrolls down (wheel, two fingers, Pan tool, PgDn, the scroll bar) and
 * the page keeps going (to BOARD_MAX_H). The teacher's band is sent as a
 * `view` op and every student shows that band at their own screen width. On
 * top of that, zoom/pan is viewer-local (pinch / Ctrl+wheel / drag, Reset
 * button): nothing is sent, and strokes map back through the transform so
 * annotation stays exact. Pictures and PDF pages are uploaded once
 * (`uploadImage`) and referenced as `asset:<id>`.
 *
 * Ink feels immediate: every pointer sample (coalesced events, plus the
 * browser's predicted points) is painted on the next frame, while the network
 * still gets one `pts` op per BATCH_MS. Lines have an even width (no stylus
 * pressure: Nov 27). Holding the
 * pen still at the end of a stroke snaps a rough line / box / circle /
 * triangle into a clean shape.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import {
  BACKGROUNDS,
  BATCH_MS,
  PAGE_H,
  PAGE_W,
  PALETTE,
  PointBatcher,
  clampScroll,
  contentBottom,
  currentPage,
  hitItem,
  inkFor,
  inverseOf,
  itemBounds,
  itemsInRect,
  newId,
  pageBand,
  transformItem,
  type Background,
  type Item,
  type Op,
  type ShapeKind,
  type StrokeItem,
} from './model';
import { LayeredRenderer, bandView, drawLaser, preloadImages, renderPageToCanvas, toPage, visibleH, type View } from './render';
import { SNAP_HOLD_MS, SNAP_STILL_PX, recognizeShape } from './recognize';
import { jpegsToPdf } from './pdf';
import { FlyoutBar, barBtn, type FlyoutGroup } from './FlyoutBar';
import { DRAW_GROUP_LABEL, DRAW_GROUP_TOOLS, drawGroupIcon } from './toolGroups';
import { WbIcon, type WbIconName } from './icons';
import { ZP_IDENTITY, clampZP, isZoomed, panBy, pinchZP, wheelFactor, zoomAt, type ZoomPan } from '../zoomPan';
import type { WhiteboardSession } from './session';

export type Tool = 'select' | 'pen' | 'hl' | 'laser' | 'eraser' | 'area' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'tri' | 'text' | 'hand';

type Props = {
  session: WhiteboardSession;
  mode: 'edit' | 'annotate' | 'view';
  identity: string;
  /** Send ops to everyone (already applied locally). */
  onSend?: (ops: Op[]) => void;
  /** Teacher's laser pointer points (page units), batched; lossy. */
  onLaser?: (pts: number[]) => void;
  onClose?: () => void;
  style?: CSSProperties;
  /** Small label shown in view mode while waiting for the first snapshot. */
  waitingLabel?: string;
  /** Hide the Stop button in the tool column (the host shows it elsewhere). */
  hideStop?: boolean;
  /** Disable viewer zoom/pan (pinch, wheel, drag, Reset button). Used by the admin observer. */
  disableZoom?: boolean;
  /**
   * Teacher: store an image for the class; resolves to the item `src`
   * (`asset:<id>`) or null when the upload failed. Without it pictures are
   * embedded as small data URLs and PDF import is not offered.
   */
  uploadImage?: (blob: Blob) => Promise<string | null>;
};

export const WIDTHS = [2, 4, 8, 14, 24];
const SHAPES: ShapeKind[] = ['line', 'arrow', 'rect', 'ellipse', 'tri'];
const FILLABLE = new Set<ShapeKind>(['rect', 'ellipse', 'tri']);
const BG_LABEL: Record<Background, string> = { white: 'Plain', grid: 'Grid', lined: 'Lined', dots: 'Dots', graph: 'Graph', black: 'Black' };
const TOOL_LABEL: Record<Tool, string> = {
  select: 'Select, move and resize (V)',
  pen: 'Pen (P)',
  hl: 'Highlighter (H)',
  laser: 'Laser pointer (L)',
  eraser: 'Eraser (E)',
  area: 'Area eraser',
  line: 'Line',
  arrow: 'Arrow',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  tri: 'Triangle',
  text: 'Text (T)',
  hand: 'Pan',
};
const TOOL_ICON: Record<Tool, WbIconName> = {
  select: 'select', pen: 'pen', hl: 'highlighter', laser: 'laser', eraser: 'eraser', area: 'areaEraser',
  line: 'line', arrow: 'arrow', rect: 'rect', ellipse: 'ellipse', tri: 'tri', text: 'text', hand: 'hand',
};
/** Laser points leave at most this often. */
const LASER_SEND_MS = 50;

type Box = { x: number; y: number; w: number; h: number };
type Xf = { s: number; ox: number; oy: number; dx: number; dy: number };

function unionBounds(items: Item[]): Box | null {
  if (!items.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of items) {
    const b = itemBounds(it);
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const xfBox = (b: Box, t: Xf): Box => ({ x: (b.x - t.ox) * t.s + t.ox + t.dx, y: (b.y - t.oy) * t.s + t.oy + t.dy, w: b.w * t.s, h: b.h * t.s });

/** No text selection, no iOS long-press menu or magnifier on the board. */
const NO_SELECT: CSSProperties = { userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' } as CSSProperties;

/** Teacher's band leaves at most this often while scrolling. */
const VIEW_SEND_MS = 100;
/** PDF pages are placed this wide on the 1920-wide page. */
const PDF_PAGE_W = 1600;

export function WhiteboardBoard({ session, mode, identity, onSend, onLaser, onClose, style, waitingLabel, hideStop, disableZoom = false, uploadImage }: Props) {
  const version = useSyncExternalStore(
    (fn) => session.subscribe(fn),
    () => session.version,
    () => session.version
  );
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // iPad (Apple Pencil / long press): no text selection, no Copy / Translate
  // menu and no magnifier while writing. Only the text tool's box may select.
  useEffect(() => {
    const root = rootRef.current;
    const doc = root?.ownerDocument;
    if (!root || !doc) return;
    const block = (e: Event) => {
      const t = e.target as Node | null;
      if (!t || !root.contains(t)) return;
      const tag = (t as HTMLElement).tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      e.preventDefault();
    };
    doc.addEventListener('selectstart', block);
    // A selection that started elsewhere must not grow across the board.
    const clear = () => {
      const sel = doc.getSelection();
      if (sel && !sel.isCollapsed && sel.anchorNode && root.contains(sel.anchorNode)) sel.removeAllRanges();
    };
    doc.addEventListener('selectionchange', clear);
    return () => {
      doc.removeEventListener('selectstart', block);
      doc.removeEventListener('selectionchange', clear);
    };
  }, []);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tool, setToolState] = useState<Tool>('pen');
  const page = currentPage(session.doc);
  const [color, setColor] = useState<string>(() => inkFor(page.bg));
  const [width, setWidth] = useState(4);
  const [fill, setFill] = useState(false);
  // Viewer-local zoom / pan on top of the fitted page (lib/zoomPan.ts).
  const [zp, setZp] = useState<ZoomPan>(ZP_IDENTITY);
  const minZoom = 1;
  const pointers = useRef(new Map<number, [number, number]>());
  const [preview, setPreview] = useState<Item[]>([]);
  const [textAt, setTextAt] = useState<{ x: number; y: number; sx: number; sy: number } | null>(null);
  const [imgTick, setImgTick] = useState(0);
  const [selection, setSelection] = useState<string[]>([]);
  const undoRef = useRef<{ redo: Op[]; undo: Op[] }[]>([]);
  const redoRef = useRef<{ redo: Op[]; undo: Op[] }[]>([]);
  const [, setStackTick] = useState(0);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const editing = mode !== 'view';
  // Teacher's scroll position (page units from the top edge); students follow page.y.
  const [scrollY, setScrollY] = useState(() => pageBand(page).y);
  const [busy, setBusy] = useState<string | null>(null);
  const canvasId = useId();

  const setTool = (t: Tool) => {
    setToolState(t);
    if (t !== 'select') setSelection([]);
  };

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    const RO = (el.ownerDocument.defaultView as (Window & { ResizeObserver?: typeof ResizeObserver }) | null)?.ResizeObserver ?? globalThis.ResizeObserver;
    const ro = RO ? new RO(read) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  const followY = page.y ?? 0;
  const followH = page.vh ?? PAGE_H;
  const base: View = useMemo(
    () => (mode === 'edit' ? bandView(size.w, size.h, { y: scrollY, h: PAGE_H }, 'edit') : bandView(size.w, size.h, pageBand({ id: '', bg: 'white', items: [], y: followY, vh: followH }), 'follow')),
    [mode, size.w, size.h, scrollY, followY, followH]
  );
  const view: View = useMemo(() => ({ scale: base.scale * zp.s, tx: base.tx * zp.s + zp.x, ty: base.ty * zp.s + zp.y }), [base, zp]);
  /** Height of the teacher's band in page units (what students are shown). */
  const bandH = mode === 'edit' && size.w && size.h ? Math.max(100, visibleH(base, size.h)) : followH;
  const scrollTo = useCallback((y: number) => setScrollY(clampScroll(y, bandH)), [bandH]);
  const scrollBy = useCallback((dy: number) => setScrollY((v) => clampScroll(v + dy, bandH)), [bandH]);
  // Teachers have no zoom (Nov 27): the page is always the full width; they only scroll.
  const zoomBy = (factor: number, sx = size.w / 2, sy = size.h / 2) => { if (!disableZoom && mode !== 'edit') setZp((t) => zoomAt(t, factor, sx, sy, size.w, size.h, minZoom)); };
  const resetZoom = () => setZp(ZP_IDENTITY);

  // Selection: ids still on the current page (a remote delete or a page change drops them).
  const selItems = useMemo(() => {
    if (!selection.length) return [];
    const ids = new Set(selection);
    return page.items.filter((it) => ids.has(it.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, page, version]);
  const selBox = useMemo(() => unionBounds(selItems), [selItems]);
  useEffect(() => {
    if (selection.length && selItems.length !== selection.length) setSelection(selItems.map((it) => it.id));
  }, [selection, selItems]);

  // ---- painting ----
  // Render on change only (doc, preview, size, images, live ink, laser): no
  // idle loop. At most one paint per animation frame, none while the window
  // is hidden, and a cached layer for everything but what is moving.
  const layered = useRef(new LayeredRenderer());
  const frame = useRef(0);
  const paintRef = useRef<() => void>(() => undefined);
  const selXf = useRef<Xf | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const drag = useRef<{
    kind: Tool;
    batcher?: PointBatcher;
    item?: Item;
    start?: { x: number; y: number };
    erased?: Set<string>;
    panFrom?: { x: number; y: number; t: ZoomPan };
    timer?: number;
    /** Browser-predicted points (drawn, never sent). */
    predicted?: number[];
    /** Hold-to-snap: where the pen last moved, and the pending timer. */
    holdAt?: { x: number; y: number };
    snapT?: number;
    snapped?: boolean;
    /** Selection: band (pick), move or scale (corner handle). */
    sel?: 'band' | 'move' | 'scale';
  } | null>(null);

  /** The growing stroke's points that have not left yet, drawn right away. */
  const liveTail = (): Item[] => {
    const d = drag.current;
    if (!d?.batcher || d.snapped || !d.item) return [];
    const pend = d.batcher.peek();
    const pred = d.predicted ?? [];
    if (!pend.length && !pred.length) return [];
    const it = currentPage(session.doc).items.find((x) => x.id === d.item!.id) as StrokeItem | undefined;
    if (!it || it.k !== 'stroke') return [];
    const n = it.pts.length;
    const pts = [it.pts[n - 2]!, it.pts[n - 1]!, ...pend, ...pred];
    return [{ ...it, id: 'live-tail', pts }];
  };

  paintRef.current = () => {
    const c = canvasRef.current;
    if (!c || !size.w || !size.h) return;
    const dpr = Math.min(2, (c.ownerDocument.defaultView?.devicePixelRatio ?? 1) || 1);
    const W = Math.round(size.w * dpr), H = Math.round(size.h * dpr);
    if (c.width !== W) c.width = W;
    if (c.height !== H) c.height = H;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const now = Date.now();
    const v = viewRef.current;
    let pg = currentPage(session.doc);
    let hot = session.hotIds(now);
    const xf = selXf.current;
    if (xf && selection.length) {
      // Moving / resizing: the selection is drawn live where it is going.
      const ids = new Set(selection);
      hot = new Set([...hot, ...ids]);
      pg = { ...pg, items: pg.items.map((it) => (ids.has(it.id) ? transformItem(it, xf) : it)) };
    }
    layered.current.render(ctx, pg, v, {
      cssW: size.w,
      cssH: size.h,
      dpr,
      extra: [...preview, ...liveTail()],
      onImage: () => {
        layered.current.invalidate();
        setImgTick((n) => n + 1);
      },
      structVersion: session.structVersion,
      hot,
    });
    if (selBox && mode === 'edit') {
      const b = xf ? xfBox(selBox, xf) : selBox;
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const x = b.x * v.scale + v.tx, y = b.y * v.scale + v.ty, w = b.w * v.scale, h = b.h * v.scale;
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x - 4, y - 4, w + 8, h + 8);
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x + w - 3, y + h - 3, 14, 14);
      ctx.strokeRect(x + w - 3, y + h - 3, 14, 14);
      ctx.restore();
    }
    // Laser trail: keep animating while it fades.
    if (session.laser.prune(now)) {
      drawLaser(ctx, session.laser, v, dpr, now);
      schedulePaint();
    }
  };
  const schedulePaint = useCallback(() => {
    const win = canvasRef.current?.ownerDocument.defaultView ?? null;
    if (!win || win.document.hidden || frame.current) return;
    frame.current = win.requestAnimationFrame(() => {
      frame.current = 0;
      paintRef.current();
    });
  }, []);
  useEffect(() => {
    schedulePaint();
  }, [version, preview, size.w, size.h, view, imgTick, session, selection, selBox, schedulePaint]);
  useEffect(() => session.onLaser(schedulePaint), [session, schedulePaint]);
  useEffect(() => {
    const c = canvasRef.current;
    const doc = c?.ownerDocument;
    if (!doc) return;
    const onVis = () => {
      if (!doc.hidden) paintRef.current();
    };
    doc.addEventListener('visibilitychange', onVis);
    return () => {
      doc.removeEventListener('visibilitychange', onVis);
      if (frame.current) doc.defaultView?.cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, []);

  const send = useCallback(
    (ops: Op[], record?: { undo: Op[] }) => {
      if (!ops.length) return;
      session.apply(ops);
      onSend?.(ops);
      if (record) {
        undoRef.current.push({ redo: ops, undo: record.undo });
        if (undoRef.current.length > 200) undoRef.current.shift();
        redoRef.current = [];
        setStackTick((n) => n + 1);
      }
    },
    [session, onSend]
  );

  // Perform ops on one page, recording one undo step that restores it.
  const actAll = useCallback(
    (ops: Op[]) => {
      if (!ops.length) return;
      const undo: Op[] = [];
      for (const op of ops) {
        const pid = 'p' in op ? (op as { p: string }).p : null;
        const before = pid ? JSON.parse(JSON.stringify(session.doc.pages.find((p) => p.id === pid) ?? null)) : undefined;
        undo.unshift(...inverseOf(op, before ?? undefined, session.doc));
        session.apply([op]);
      }
      onSend?.(ops);
      undoRef.current.push({ redo: ops, undo });
      if (undoRef.current.length > 200) undoRef.current.shift();
      redoRef.current = [];
      setStackTick((n) => n + 1);
    },
    [session, onSend]
  );
  const act = useCallback((op: Op) => actAll([op]), [actAll]);

  // Teacher: another page (or a board restored on rejoin) starts where it was left.
  useEffect(() => {
    if (mode === 'edit') setScrollY(pageBand(currentPage(session.doc)).y);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, page.id]);
  // Teacher: tell students which band is on screen (throttled; the last one always leaves).
  const viewSent = useRef({ key: '', at: 0, timer: 0 });
  useEffect(() => {
    if (mode !== 'edit' || !size.w || !size.h) return;
    const vs = viewSent.current;
    const go = () => {
      vs.timer = 0;
      const pg = currentPage(session.doc);
      const y = Math.round(clampScroll(scrollY, bandH));
      const key = `${pg.id}|${y}|${bandH}`;
      if (key === vs.key) return;
      vs.key = key;
      vs.at = Date.now();
      send([{ k: 'view', p: pg.id, y, h: bandH }]);
    };
    if (vs.timer) window.clearTimeout(vs.timer);
    const wait = VIEW_SEND_MS - (Date.now() - vs.at);
    if (wait <= 0) go();
    else vs.timer = window.setTimeout(go, wait);
  }, [mode, scrollY, bandH, size.w, size.h, page.id, send, session]);
  useEffect(() => () => window.clearTimeout(viewSent.current.timer), []);

  const undo = () => {
    const e = undoRef.current.pop();
    if (!e) return;
    redoRef.current.push(e);
    send(e.undo);
    setStackTick((n) => n + 1);
  };
  const redo = () => {
    const e = redoRef.current.pop();
    if (!e) return;
    undoRef.current.push(e);
    send(e.redo);
    setStackTick((n) => n + 1);
  };

  // ---- laser (teacher) ----
  const laserBuf = useRef<number[]>([]);
  const laserT = useRef<number | null>(null);
  const laserAt = (x: number, y: number) => {
    const pt = [Math.round(x), Math.round(y)];
    session.addLaser(pt);
    laserBuf.current.push(...pt);
    if (laserT.current === null) {
      laserT.current = window.setTimeout(() => {
        laserT.current = null;
        const pts = laserBuf.current;
        laserBuf.current = [];
        if (pts.length) onLaser?.(pts);
      }, LASER_SEND_MS);
    }
  };
  useEffect(() => () => {
    if (laserT.current !== null) window.clearTimeout(laserT.current);
  }, []);

  // ---- pointer drawing ----
  const mine = useCallback((it: Item) => mode === 'edit' || it.by === identity, [mode, identity]);

  const pageXY = (clientX: number, clientY: number) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return toPage(viewRef.current, clientX - r.left, clientY - r.top);
  };
  const pagePoint = (e: { clientX: number; clientY: number }) => pageXY(e.clientX, e.clientY);

  // `d` explicitly: on pen-up the drag is already cleared, and the last
  // points (up to BATCH_MS of drawing) must still leave.
  const flushPts = (d = drag.current) => {
    const op = d?.batcher?.flush();
    if (op) {
      session.apply([op]);
      onSend?.([op]);
    }
  };

  const eraseAt = (x: number, y: number) => {
    const d = drag.current!;
    const r = 10 / view.scale;
    const pg = currentPage(session.doc);
    const ids = pg.items.filter((it) => mine(it) && !d.erased!.has(it.id) && hitItem(it, x, y, r)).map((it) => it.id);
    if (!ids.length) return;
    ids.forEach((id) => d.erased!.add(id));
    act({ k: 'del', p: pg.id, ids });
  };

  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  /** Hold-to-snap: the pen stayed still long enough; replace the stroke with its clean shape. */
  const trySnap = () => {
    const d = drag.current;
    if (!d?.batcher || d.snapped || d.kind !== 'pen' || mode !== 'edit') return;
    flushPts();
    const pg = currentPage(session.doc);
    const it = pg.items.find((x) => x.id === d.item!.id);
    if (!it || it.k !== 'stroke') return;
    const shape = recognizeShape(it.pts);
    if (!shape) return;
    window.clearInterval(d.timer);
    d.snapped = true;
    d.predicted = [];
    const item: Item = { ...shape, id: newId('t'), by: identity, c: it.c, w: it.w, ...(fill && FILLABLE.has(shape.k) ? { fl: 1 as const } : {}) };
    const ops: Op[] = [{ k: 'del', p: pg.id, ids: [it.id] }, { k: 'add', p: pg.id, item }];
    send(ops);
    // Same as the Android app: one undo goes back to the free-hand stroke,
    // a second removes it (the stroke's own entry is not pushed on pen-up
    // once snapped).
    const drawn = JSON.parse(JSON.stringify(it)) as Item;
    undoRef.current.push({ redo: [{ k: 'add', p: pg.id, item: drawn }], undo: [{ k: 'del', p: pg.id, ids: [drawn.id] }] });
    undoRef.current.push({ redo: ops, undo: [{ k: 'del', p: pg.id, ids: [item.id] }, { k: 'add', p: pg.id, item: drawn }] });
    redoRef.current = [];
    setStackTick((n) => n + 1);
  };
  const armSnap = (x: number, y: number, force = false) => {
    const d = drag.current;
    if (!d || mode !== 'edit' || d.kind !== 'pen' || d.snapped) return;
    if (!force && d.holdAt && Math.hypot(x - d.holdAt.x, y - d.holdAt.y) < SNAP_STILL_PX) return;
    d.holdAt = { x, y };
    window.clearTimeout(d.snapT);
    d.snapT = window.setTimeout(trySnap, SNAP_HOLD_MS);
  };

  const onDown = (e: React.PointerEvent) => {
    if (textAt || (disableZoom && !editing)) return;
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* the pointer is already gone (some pens / browsers): draw without capture */
    }
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size >= 2) {
      if (disableZoom) return;
      // Second finger: pinch-zoom / two-finger pan (any mode). A stroke the
      // first finger just started is kept as drawn so far.
      const d = drag.current;
      if (d?.batcher) {
        window.clearInterval(d.timer);
        window.clearTimeout(d.snapT);
        flushPts();
      }
      setPreview([]);
      selXf.current = null;
      drag.current = { kind: 'hand' };
      return;
    }
    const pt = pagePoint(e);
    const pg = currentPage(session.doc);
    const t: Tool = !editing ? 'hand' : mode === 'annotate' && !['pen', 'eraser'].includes(tool) ? 'pen' : e.button === 1 ? 'hand' : tool;
    if (t === 'hand') {
      drag.current = { kind: t, panFrom: { x: e.clientX, y: e.clientY, t: zp } };
      return;
    }
    if (t === 'laser') {
      drag.current = { kind: t };
      laserAt(pt.x, pt.y);
      return;
    }
    if (t === 'pen' || t === 'hl') {
      const id = newId(mode === 'edit' ? 't' : 's');
      const w = t === 'hl' ? width * 3 : width;
      const item: StrokeItem = { k: 'stroke', id, by: identity, tool: t, c: color, w, pts: [Math.round(pt.x), Math.round(pt.y)] };
      send([{ k: 'add', p: pg.id, item }]);
      const batcher = new PointBatcher(pg.id, id);
      const timer = window.setInterval(() => flushPts(), BATCH_MS);
      drag.current = { kind: t, batcher, item, timer };
      armSnap(pt.x, pt.y, true);
      return;
    }
    if (t === 'eraser') {
      drag.current = { kind: t, erased: new Set() };
      eraseAt(pt.x, pt.y);
      return;
    }
    if (t === 'text') {
      const r = canvasRef.current!.getBoundingClientRect();
      setTextAt({ x: pt.x, y: pt.y, sx: e.clientX - r.left, sy: e.clientY - r.top });
      return;
    }
    if (t === 'select') {
      const pad = 10 / view.scale;
      if (selBox) {
        const hx = selBox.x + selBox.w, hy = selBox.y + selBox.h;
        if (Math.abs(pt.x - hx) <= 18 / view.scale && Math.abs(pt.y - hy) <= 18 / view.scale) {
          drag.current = { kind: t, sel: 'scale', start: pt };
          return;
        }
        if (pt.x >= selBox.x - pad && pt.x <= hx + pad && pt.y >= selBox.y - pad && pt.y <= hy + pad) {
          drag.current = { kind: t, sel: 'move', start: pt };
          return;
        }
      }
      // Pressing on an item selects it and starts moving it straight away.
      const hit = [...pg.items].reverse().find((it) => hitItem(it, pt.x, pt.y, pad));
      if (hit) {
        setSelection([hit.id]);
        drag.current = { kind: t, sel: 'move', start: pt };
        return;
      }
      setSelection([]);
      drag.current = { kind: t, sel: 'band', start: pt };
      return;
    }
    drag.current = { kind: t, start: pt };
  };

  const onMove = (e: React.PointerEvent) => {
    if (disableZoom && !editing) return;
    const prev = pointers.current.get(e.pointerId);
    if (prev && pointers.current.size >= 2) {
      if (disableZoom) return;
      const next = local(e);
      const other = [...pointers.current.entries()].find(([id]) => id !== e.pointerId)?.[1];
      pointers.current.set(e.pointerId, next);
      if (!other) return;
      if (mode === 'edit') {
        // Teacher: two fingers only scroll the long page (no zoom).
        const dyMid = (next[1] - prev[1]) / 2;
        if (dyMid) scrollBy(-dyMid / viewRef.current.scale);
      } else setZp((t) => pinchZP(t, prev, other, next, other, size.w, size.h, minZoom));
      return;
    }
    if (prev) pointers.current.set(e.pointerId, local(e));
    const d = drag.current;
    // The laser follows the mouse even without a button pressed.
    if (!d && mode === 'edit' && tool === 'laser' && e.pointerType === 'mouse') {
      const pt = pagePoint(e);
      return laserAt(pt.x, pt.y);
    }
    if (!d) return;
    if (d.kind === 'hand') {
      if (d.panFrom && mode === 'edit') {
        // Teacher: up/down scrolls the long page (no zoom, so nothing to pan sideways).
        const dy = e.clientY - d.panFrom.y;
        d.panFrom = { x: e.clientX, y: e.clientY, t: d.panFrom.t };
        if (dy) scrollBy(-dy / viewRef.current.scale);
      } else if (d.panFrom) setZp(panBy(d.panFrom.t, e.clientX - d.panFrom.x, e.clientY - d.panFrom.y, size.w, size.h, minZoom));
      return;
    }
    if (d.kind === 'laser') {
      const pt = pagePoint(e);
      return laserAt(pt.x, pt.y);
    }
    if (d.batcher) {
      if (d.snapped) return;
      // Every sample the hardware delivered (a stylus reports 120–240 Hz),
      // not just one per frame.
      const ne = e.nativeEvent as PointerEvent;
      const list = typeof ne.getCoalescedEvents === 'function' ? ne.getCoalescedEvents() : [];
      for (const ce of list.length ? list : [ne]) {
        const p = pageXY(ce.clientX, ce.clientY);
        d.batcher.push(p.x, p.y);
      }
      const pred = typeof ne.getPredictedEvents === 'function' ? ne.getPredictedEvents() : [];
      d.predicted = pred.slice(0, 3).flatMap((pe) => {
        const p = pageXY(pe.clientX, pe.clientY);
        return [Math.round(p.x), Math.round(p.y)];
      });
      const last = pageXY(ne.clientX, ne.clientY);
      armSnap(last.x, last.y);
      schedulePaint();
      return;
    }
    const pt = pagePoint(e);
    if (d.kind === 'eraser') return eraseAt(pt.x, pt.y);
    if (d.kind === 'select' && d.start) {
      const s = d.start;
      if (d.sel === 'band') {
        setPreview([{ k: 'rect', id: 'preview', by: identity, c: '#3b82f6', w: 2 / view.scale, x1: s.x, y1: s.y, x2: pt.x, y2: pt.y }]);
      } else if (d.sel === 'move') {
        selXf.current = { s: 1, ox: 0, oy: 0, dx: Math.round(pt.x - s.x), dy: Math.round(pt.y - s.y) };
        schedulePaint();
      } else if (d.sel === 'scale' && selBox) {
        const sx = (pt.x - selBox.x) / Math.max(1, selBox.w), sy = (pt.y - selBox.y) / Math.max(1, selBox.h);
        const k = Math.min(10, Math.max(0.1, Math.max(sx, sy)));
        selXf.current = { s: k, ox: selBox.x, oy: selBox.y, dx: 0, dy: 0 };
        schedulePaint();
      }
      return;
    }
    if (d.start) {
      const s = d.start;
      const id = 'preview';
      if (d.kind === 'area') {
        setPreview([{ k: 'rect', id, by: identity, c: '#e53935', w: 2 / view.scale, x1: s.x, y1: s.y, x2: pt.x, y2: pt.y }]);
      } else if (SHAPES.includes(d.kind as ShapeKind)) {
        const k = d.kind as ShapeKind;
        setPreview([{ k, id, by: identity, c: color, w: width, x1: s.x, y1: s.y, x2: pt.x, y2: pt.y, ...(fill && FILLABLE.has(k) ? { fl: 1 as const } : {}) }]);
      }
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const wasPinch = pointers.current.size >= 2;
    pointers.current.delete(e.pointerId);
    if (wasPinch) {
      // Lift of one pinch finger: nothing to finish, wait for the other.
      if (pointers.current.size === 0) drag.current = null;
      else drag.current = { kind: 'hand' };
      return;
    }
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const pg = currentPage(session.doc);
    if (d.batcher) {
      window.clearInterval(d.timer);
      window.clearTimeout(d.snapT);
      if (d.snapped) return schedulePaint();
      flushPts(d);
      d.predicted = [];
      const full = pg.items.find((x) => x.id === d.item!.id);
      if (full) {
        undoRef.current.push({ redo: [{ k: 'add', p: pg.id, item: JSON.parse(JSON.stringify(full)) }], undo: [{ k: 'del', p: pg.id, ids: [full.id] }] });
        redoRef.current = [];
        setStackTick((n) => n + 1);
      }
      schedulePaint();
      return;
    }
    if (d.kind === 'select' && d.start) {
      const pt = pagePoint(e);
      if (d.sel === 'band') {
        setPreview([]);
        if (Math.hypot(pt.x - d.start.x, pt.y - d.start.y) > 4 / view.scale) setSelection(itemsInRect(pg, d.start.x, d.start.y, pt.x, pt.y));
        return;
      }
      const xf = selXf.current;
      selXf.current = null;
      if (xf && (xf.s !== 1 || xf.dx || xf.dy) && selection.length) act({ k: 'xf', p: pg.id, ids: selection, ...xf });
      else schedulePaint();
      return;
    }
    if (d.start) {
      const pt = pagePoint(e);
      setPreview([]);
      if (d.kind === 'area') {
        const ids = itemsInRect(pg, d.start.x, d.start.y, pt.x, pt.y, mine);
        if (ids.length) act({ k: 'del', p: pg.id, ids });
        return;
      }
      if (Math.hypot(pt.x - d.start.x, pt.y - d.start.y) < 3) return;
      if (SHAPES.includes(d.kind as ShapeKind)) {
        const k = d.kind as ShapeKind;
        act({
          k: 'add',
          p: pg.id,
          item: { k, id: newId('t'), by: identity, c: color, w: width, x1: Math.round(d.start.x), y1: Math.round(d.start.y), x2: Math.round(pt.x), y2: Math.round(pt.y), ...(fill && FILLABLE.has(k) ? { fl: 1 as const } : {}) },
        });
      }
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    if (disableZoom) return;
    // Teacher: the wheel (with or without Ctrl) only scrolls the long page. Viewers: wheel zooms.
    if (mode === 'edit') {
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * size.h : e.deltaY;
      if (px) scrollBy(px / viewRef.current.scale);
      return;
    }
    const [sx, sy] = local(e);
    zoomBy(wheelFactor(e.deltaY, e.deltaMode), sx, sy);
  };
  // Keep the transform valid when the box resizes.
  useEffect(() => {
    if (size.w && size.h) setZp((t) => clampZP(t, size.w, size.h, minZoom));
  }, [size.w, size.h, minZoom]);

  const deleteSelection = () => {
    if (!selection.length) return;
    act({ k: 'del', p: currentPage(session.doc).id, ids: selection });
    setSelection([]);
  };
  const duplicateSelection = () => {
    if (!selItems.length) return;
    const pid = currentPage(session.doc).id;
    const copies = selItems.map((it) => transformItem({ ...JSON.parse(JSON.stringify(it)), id: newId('t'), by: identity }, { s: 1, ox: 0, oy: 0, dx: 30, dy: 30 }));
    actAll(copies.map((item) => ({ k: 'add', p: pid, item })));
    setSelection(copies.map((c) => c.id));
  };

  // Keyboard shortcuts (edit / annotate).
  useEffect(() => {
    if (mode === 'view') return;
    const win = wrapRef.current?.ownerDocument.defaultView ?? window;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && k === 'y') {
        e.preventDefault();
        redo();
      } else if (mode !== 'edit') return;
      else if (mod && k === 'd' && selection.length) {
        e.preventDefault();
        duplicateSelection();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selection.length) {
        e.preventDefault();
        deleteSelection();
      } else if (e.key === 'Escape') setSelection([]);
      else if (e.key === 'PageDown') scrollBy(bandH * 0.85);
      else if (e.key === 'PageUp') scrollBy(-bandH * 0.85);
      else if (e.key === 'Home' && !mod) scrollTo(0);
      else if (!mod && !e.altKey) {
        const map: Record<string, Tool> = { v: 'select', p: 'pen', h: 'hl', l: 'laser', e: 'eraser', t: 'text' };
        if (map[k]) setTool(map[k]!);
      }
    };
    win.addEventListener('keydown', onKey);
    return () => win.removeEventListener('keydown', onKey);
  });

  const goPage = (delta: number) => {
    const cur = session.doc.cur + delta;
    if (cur < 0 || cur >= session.doc.pages.length) return;
    setSelection([]);
    act({ k: 'go', cur });
  };
  const newPage = () => {
    setSelection([]);
    act({ k: 'newpage', at: session.doc.cur + 1, id: newId('p'), bg: currentPage(session.doc).bg });
  };
  const setBg = (bg: Background) => {
    act({ k: 'bg', p: currentPage(session.doc).id, bg });
    if ((bg === 'black' && color === '#111111') || (bg !== 'black' && color === '#ffffff')) setColor(inkFor(bg));
  };

  const commitText = (text: string) => {
    const at = textAt;
    setTextAt(null);
    if (!at || !text.trim()) return;
    act({ k: 'add', p: currentPage(session.doc).id, item: { k: 'text', id: newId('t'), by: identity, c: color, size: 24 + width * 4, x: Math.round(at.x), y: Math.round(at.y), text } });
  };

  /** Upload an image (asset) or, without an uploader / on failure, embed a small data URL. */
  const imageSrc = async (canvas: HTMLCanvasElement): Promise<string> => {
    if (uploadImage) {
      const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
      const src = blob ? await uploadImage(blob).catch(() => null) : null;
      if (src) return src;
    }
    return canvas.toDataURL('image/jpeg', 0.8);
  };

  const insertImage = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        void (async () => {
          const max = 1600;
          const k = Math.min(1, max / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * k));
          c.height = Math.max(1, Math.round(img.height * k));
          c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
          setBusy('Adding picture…');
          const src = await imageSrc(c).finally(() => setBusy(null));
          // In the middle of what the teacher sees, ready to move or resize.
          const fit = Math.min(1, (PAGE_W * 0.7) / c.width, (bandH * 0.7) / c.height);
          const w = Math.round(c.width * fit), h = Math.round(c.height * fit);
          const id = newId('t');
          act({ k: 'add', p: currentPage(session.doc).id, item: { k: 'img', id, by: identity, src, x: Math.round((PAGE_W - w) / 2), y: Math.round(scrollY + (bandH - h) / 2), w, h } });
          setToolState('select');
          setSelection([id]);
        })();
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  };

  /**
   * PDF: every page becomes a picture, stacked down the page below what is
   * already written; the teacher is taken to the first one. One undo removes
   * the whole import.
   */
  const importPdf = async (file: File) => {
    if (!uploadImage) return;
    const pg = currentPage(session.doc);
    const startY = Math.max(40, contentBottom(pg) + 80);
    scrollTo(startY - 40);
    const ops: Op[] = [];
    let y = startY;
    try {
      const { renderPdfPages, PDF_MAX_PAGES } = await import('./pdfImport');
      setBusy('Opening PDF…');
      const total = await renderPdfPages(file, async (pic, i, n) => {
        setBusy(`Adding PDF page ${i + 1} of ${n}…`);
        const src = await uploadImage(pic.blob).catch(() => null);
        if (!src) throw new Error('upload');
        const w = PDF_PAGE_W, h = Math.round((pic.h * PDF_PAGE_W) / pic.w);
        const op: Op = { k: 'add', p: pg.id, item: { k: 'img', id: newId('t'), by: identity, src, x: Math.round((PAGE_W - w) / 2), y, w, h, bd: 1 } };
        send([op]);
        ops.push(op);
        y += h + 40;
      });
      setBusy(total > PDF_MAX_PAGES ? `Added the first ${PDF_MAX_PAGES} of ${total} pages` : null);
      if (total > PDF_MAX_PAGES) window.setTimeout(() => setBusy(null), 5000);
    } catch (e) {
      const msg = e instanceof Error && e.message === 'upload' ? 'Could not upload a PDF page. Check the connection and try again.' : 'Could not open this PDF.';
      setBusy(msg);
      window.setTimeout(() => setBusy(null), 5000);
    }
    if (ops.length) {
      const ids = ops.map((o) => (o as Extract<Op, { k: 'add' }>).item.id);
      undoRef.current.push({ redo: ops, undo: [{ k: 'del', p: pg.id, ids }] });
      redoRef.current = [];
      setStackTick((n) => n + 1);
    }
  };

  const onFile = (f: File) => {
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) void importPdf(f);
    else insertImage(f);
  };

  const download = (name: string, url: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  /** What the teacher sees now. */
  const exportPng = async () => {
    const pg = currentPage(session.doc);
    await preloadImages(pg.items);
    const c = document.createElement('canvas');
    renderPageToCanvas(pg, c, undefined, { y: Math.round(scrollY), h: bandH });
    download(`whiteboard-page-${session.doc.cur + 1}.png`, c.toDataURL('image/png'));
  };
  /** Every page, cut into screen-high sheets down to the last thing written. */
  const exportPdf = async () => {
    const pages: { jpeg: Uint8Array; w: number; h: number }[] = [];
    for (const p of session.doc.pages) {
      await preloadImages(p.items);
      const sheets = Math.min(100, Math.max(1, Math.ceil(contentBottom(p) / PAGE_H)));
      for (let i = 0; i < sheets && pages.length < 300; i++) {
        const c = document.createElement('canvas');
        renderPageToCanvas(p, c, undefined, { y: i * PAGE_H, h: PAGE_H });
        const blob: Blob | null = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9));
        if (blob) pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: PAGE_W, h: PAGE_H });
      }
    }
    const pdf = jpegsToPdf(pages);
    const url = URL.createObjectURL(new Blob([pdf as BlobPart], { type: 'application/pdf' }));
    download('whiteboard.pdf', url);
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const cursor = !editing ? (!disableZoom && isZoomed(zp) ? 'grab' : 'default') : tool === 'hand' ? 'grab' : tool === 'text' ? 'text' : tool === 'select' ? 'default' : tool === 'laser' ? 'none' : 'crosshair';
  const btn = (active: boolean, extra?: CSSProperties): CSSProperties => barBtn(active, { minWidth: 38, height: 38, fontSize: 13, ...extra });
  const icon = (n: WbIconName) => <WbIcon name={n} />;
  const toolBtn = (t: Tool) => (
    <button key={t} type="button" title={TOOL_LABEL[t]} aria-label={TOOL_LABEL[t]} aria-pressed={tool === t} data-wb-tool={t} style={btn(tool === t)} onClick={() => setTool(t)}>
      {icon(TOOL_ICON[t])}
    </button>
  );
  const isTool = (...ts: Tool[]) => ts.includes(tool);
  const swatch = (c: string, s = 18) => <span aria-hidden style={{ width: s, height: s, borderRadius: s / 2, background: c, border: '2px solid #e2e8f0', display: 'block' }} />;
  const colorGrid = (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 28px)', gap: 6 }} role="radiogroup" aria-label="Colour">
        {PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={color === c}
            title={`Colour ${c}`}
            aria-label={`Colour ${c}`}
            onClick={() => setColor(c)}
            style={{ width: 28, height: 28, borderRadius: 14, background: c, border: color === c ? '3px solid #60a5fa' : '1px solid #475569', cursor: 'pointer', padding: 0 }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }} role="radiogroup" aria-label="Thickness">
        {WIDTHS.map((w) => (
          <button key={w} type="button" role="radio" aria-checked={width === w} aria-label={`Thickness ${w}px`} title={`${w}px`} onClick={() => setWidth(w)} style={btn(width === w)}>
            <span style={{ width: Math.min(20, w + 2), height: Math.min(20, w + 2), borderRadius: 10, background: color, display: 'block' }} />
          </button>
        ))}
      </div>
    </>
  );
  const shapeTool = SHAPES.includes(tool as ShapeKind) ? (tool as ShapeKind) : null;
  const editGroups: FlyoutGroup[] = [
    { id: 'select', label: TOOL_LABEL.select, icon: icon('select'), active: tool === 'select', onClick: () => setTool('select'), testId: 'wb-tool-select' },
    {
      id: 'draw',
      label: DRAW_GROUP_LABEL,
      icon: icon(drawGroupIcon(tool)),
      active: isTool(...DRAW_GROUP_TOOLS),
      testId: 'wb-group-draw',
      content: <>{DRAW_GROUP_TOOLS.map((t) => toolBtn(t))}</>,
    },
    {
      id: 'shapes',
      label: 'Shapes: line, arrow, rectangle, ellipse, triangle',
      icon: icon(shapeTool ?? 'shapes'),
      active: !!shapeTool,
      content: (
        <>
          {SHAPES.map((s) => toolBtn(s))}
          <button type="button" style={btn(fill)} aria-pressed={fill} onClick={() => setFill((f) => !f)} title="Fill rectangles, ellipses and triangles" aria-label="Fill shapes">
            {icon('fill')}
          </button>
        </>
      ),
    },
    {
      id: 'erase',
      label: 'Erase',
      icon: icon(tool === 'area' ? 'areaEraser' : 'eraser'),
      active: isTool('eraser', 'area'),
      content: (
        <>
          {toolBtn('eraser')}
          {toolBtn('area')}
          <button type="button" style={btn(false)} onClick={() => act({ k: 'clear', p: currentPage(session.doc).id })} title="Clear page" aria-label="Clear page">
            {icon('clear')}
          </button>
        </>
      ),
    },
    { id: 'color', label: 'Colour and size', icon: swatch(color), content: colorGrid },
    { id: 'undo', label: 'Undo (Ctrl+Z)', icon: icon('undo'), onClick: undo, disabled: !undoRef.current.length },
    { id: 'redo', label: 'Redo (Ctrl+Y)', icon: icon('redo'), onClick: redo, disabled: !redoRef.current.length },
    {
      id: 'pages',
      label: 'Pages and background',
      icon: <span aria-hidden style={{ fontSize: 11 }} data-testid="wb-page">{session.doc.cur + 1}/{session.doc.pages.length}</span>,
      content: (
        <>
          <div style={{ display: 'flex', gap: 4 }}>
            <button type="button" style={btn(false)} onClick={() => goPage(-1)} disabled={session.doc.cur === 0} aria-label="Previous page" title="Previous page">
              {icon('prev')}
            </button>
            <button type="button" style={btn(false)} onClick={() => goPage(1)} disabled={session.doc.cur >= session.doc.pages.length - 1} aria-label="Next page" title="Next page">
              {icon('next')}
            </button>
            <button type="button" style={btn(false)} onClick={newPage} aria-label="New page" title="New page">
              {icon('addPage')}
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, auto)', gap: 4 }} role="radiogroup" aria-label="Background">
            {BACKGROUNDS.map((b) => (
              <button key={b} type="button" role="radio" aria-checked={page.bg === b} style={btn(page.bg === b, { padding: '0 8px' })} onClick={() => setBg(b)} aria-label={`Background: ${BG_LABEL[b]}`} title={`Background: ${BG_LABEL[b]}`}>
                {BG_LABEL[b]}
              </button>
            ))}
          </div>
        </>
      ),
    },
    {
      id: 'view',
      label: 'Pan, image and export',
      icon: icon('view'),
      active: isTool('hand'),
      content: (
        <>
          {toolBtn('hand')}
          <button type="button" style={btn(false)} onClick={() => fileRef.current?.click()} aria-label={uploadImage ? 'Insert image or PDF' : 'Insert image'} title={uploadImage ? 'Insert a picture or a PDF (pages go down the board)' : 'Insert image'} data-testid="wb-insert">
            {icon('image')}
          </button>
          <button type="button" style={btn(false, { padding: '0 8px' })} onClick={() => void exportPng()} aria-label="Export PNG" title="Export what is on screen as PNG">
            {icon('download')} PNG
          </button>
          <button type="button" style={btn(false, { padding: '0 8px' })} onClick={() => void exportPdf()} aria-label="Export PDF" title="Export all pages as PDF">
            {icon('download')} PDF
          </button>
        </>
      ),
    },
  ];
  const annotateGroups: FlyoutGroup[] = [
    { id: 'pen', label: 'Pen', icon: icon('pen'), active: tool !== 'eraser', onClick: () => setTool('pen') },
    { id: 'eraser', label: 'Erase my drawing', icon: icon('eraser'), active: tool === 'eraser', onClick: () => setTool('eraser') },
    { id: 'color', label: 'Colour and size', icon: swatch(color), content: colorGrid },
    { id: 'undo', label: 'Undo', icon: icon('undo'), onClick: undo, disabled: !undoRef.current.length },
    { id: 'redo', label: 'Redo', icon: icon('redo'), onClick: redo, disabled: !redoRef.current.length },
  ];
  // 54px. Must match WB_TOOL_COLUMN_PX in lib/floatGeometry.ts. Kept as a
  // literal: this file is also bundled by the Windows renderer, which does not
  // resolve the web app's `@/` alias.
  const barW = 54;

  // Floating actions above the selection (touch-friendly; keys: Delete, Ctrl+D).
  let selBar: ReactNode = null;
  if (mode === 'edit' && tool === 'select' && selBox && !selXf.current) {
    const x = Math.max(4, Math.min(size.w - 96, selBox.x * view.scale + view.tx));
    const y = Math.max(4, selBox.y * view.scale + view.ty - 48);
    selBar = (
      <div data-testid="wb-selection-bar" style={{ position: 'absolute', left: x, top: y, zIndex: 4, display: 'flex', gap: 4, padding: 4, borderRadius: 10, background: 'rgba(17,24,39,0.92)', border: '1px solid rgba(255,255,255,0.14)' }}>
        <button type="button" style={btn(false)} onClick={duplicateSelection} aria-label="Duplicate selection" title="Duplicate (Ctrl+D)">
          {icon('duplicate')}
        </button>
        <button type="button" style={btn(false, { background: '#7f1d1d' })} onClick={deleteSelection} aria-label="Delete selection" title="Delete (Del)">
          {icon('clear')}
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef} style={{ position: 'relative', width: '100%', height: '100%', background: '#0b0f14', overflow: 'hidden', ...NO_SELECT, ...style }} data-whiteboard={mode} onContextMenu={(e) => e.preventDefault()}>
      <div ref={wrapRef} style={{ position: 'absolute', inset: 0, left: mode === 'view' ? 0 : barW }}>
        <canvas
          ref={canvasRef}
          id={canvasId}
          data-testid="wb-canvas"
          style={{ width: '100%', height: '100%', display: 'block', touchAction: disableZoom ? 'auto' : 'none', cursor }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onWheel={onWheel}
        />
        {mode === 'view' && !session.ready && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#94a3b8', fontSize: 14 }}>{waitingLabel ?? 'Loading whiteboard…'}</div>
        )}
        {!disableZoom && mode !== 'edit' && isZoomed(zp) && (
          <button type="button" data-testid="wb-reset-zoom" onClick={resetZoom} style={{ ...btn(false), position: 'absolute', right: 10, bottom: 10, zIndex: 4, background: 'rgba(17,24,39,0.9)', padding: '0 12px' }}>
            Reset zoom
          </button>
        )}
        {selBar}
        {mode === 'edit' && size.h > 0 && (
          <ScrollRail
            top={scrollY}
            band={bandH}
            total={Math.max(contentBottom(page) + bandH, scrollY + bandH * 2)}
            height={size.h}
            onScroll={scrollTo}
            controls={canvasId}
          />
        )}
        {busy && (
          <div role="status" data-testid="wb-busy" style={{ position: 'absolute', left: '50%', top: 10, transform: 'translateX(-50%)', zIndex: 5, padding: '6px 12px', borderRadius: 999, background: 'rgba(17,24,39,0.92)', color: '#e2e8f0', fontSize: 13, border: '1px solid rgba(255,255,255,0.14)', pointerEvents: 'none' }}>
            {busy}
          </div>
        )}
        {textAt && (
          <textarea
            autoFocus
            data-testid="wb-text"
            style={{ userSelect: 'text', WebkitUserSelect: 'text', position: 'absolute', left: textAt.sx, top: textAt.sy, minWidth: 200, minHeight: 40, font: `${(24 + width * 4) * view.scale}px system-ui`, color, background: 'rgba(255,255,255,0.85)', border: '1px dashed #2563eb', outline: 'none', zIndex: 3 }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                commitText((e.target as HTMLTextAreaElement).value);
              } else if (e.key === 'Escape') setTextAt(null);
            }}
            onBlur={(e) => commitText(e.target.value)}
          />
        )}
      </div>
      {mode !== 'view' && (
        <FlyoutBar
          label="Whiteboard tools"
          orient="vertical"
          side="after"
          groups={mode === 'edit' ? editGroups : annotateGroups}
          style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: barW, boxSizing: 'border-box', borderRight: '1px solid rgba(255,255,255,0.1)', zIndex: 4 }}
          tail={
            onClose && !hideStop ? (
              <button type="button" style={{ ...btn(false), marginTop: 'auto', background: '#b91c1c' }} onClick={onClose} aria-label="Stop whiteboard" title="Stop whiteboard (students stop seeing it)">
                {icon('stop')}
              </button>
            ) : undefined
          }
        />
      )}
      <input ref={fileRef} type="file" data-testid="wb-file" accept={uploadImage ? 'image/png,image/jpeg,image/webp,application/pdf,.pdf' : 'image/png,image/jpeg,image/webp'} style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
    </div>
  );
}

/**
 * Teacher's scroll bar for the long page (right edge): the thumb is the band
 * on screen; the track grows with the content so there is always room below.
 * Drag the thumb or press the track; "Top" jumps back to the top edge.
 */
function ScrollRail({ top, band, total, height, onScroll, controls }: { top: number; band: number; total: number; height: number; onScroll: (y: number) => void; controls: string }) {
  const track = Math.max(40, height - 16);
  const thumb = Math.max(28, (band / total) * track);
  const at = Math.min(track - thumb, (top / Math.max(1, total - band)) * (track - thumb));
  const dragRef = useRef<{ y: number; top: number } | null>(null);
  const toY = (clientY: number, rect: DOMRect) => ((clientY - rect.top - thumb / 2) / Math.max(1, track - thumb)) * (total - band);
  return (
    <>
      <div
        data-testid="wb-scroll"
        aria-label="Scroll the board"
        role="scrollbar"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={Math.round(total - band)}
        aria-valuenow={Math.round(top)}
        aria-controls={controls}
        style={{ position: 'absolute', right: 4, top: 8, width: 12, height: track, zIndex: 4, borderRadius: 6, background: 'rgba(15,23,42,0.18)', touchAction: 'none', cursor: 'pointer' }}
        onPointerDown={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const inThumb = e.clientY - rect.top >= at && e.clientY - rect.top <= at + thumb;
          if (!inThumb) onScroll(toY(e.clientY, rect));
          dragRef.current = { y: e.clientY, top: inThumb ? top : toY(e.clientY, rect) };
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* ignore */
          }
        }}
        onPointerMove={(e) => {
          const d = dragRef.current;
          if (!d) return;
          onScroll(d.top + ((e.clientY - d.y) / Math.max(1, track - thumb)) * (total - band));
        }}
        onPointerUp={() => (dragRef.current = null)}
        onPointerCancel={() => (dragRef.current = null)}
      >
        <div style={{ position: 'absolute', left: 1, right: 1, top: at, height: thumb, borderRadius: 5, background: 'rgba(37,99,235,0.75)' }} />
      </div>
      {top > 1 && (
        <button
          type="button"
          data-testid="wb-scroll-top"
          onClick={() => onScroll(0)}
          title="Back to the top of the board (Home)"
          aria-label="Back to the top of the board"
          style={{ ...barBtn(false, { minWidth: 38, height: 30, fontSize: 12 }), position: 'absolute', right: 22, top: 8, zIndex: 4, background: 'rgba(17,24,39,0.85)', padding: '0 10px' }}
        >
          ↑ Top
        </button>
      )}
    </>
  );
}

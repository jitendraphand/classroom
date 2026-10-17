'use client';
/**
 * Whiteboard canvas + tools (React, inline styles only, so the same file runs
 * in the Next.js web app and the Windows Electron renderer).
 *
 * mode:
 *  - 'edit'     teacher: every tool, pages, background, zoom/pan, image, export
 *  - 'annotate' student allowed to draw: pen colours + erase own strokes
 *  - 'view'     student / admin preview: render only
 * The page always fits the viewport the same way on every device; zoom/pan is
 * viewer-local (pinch / wheel / drag, Reset button): nothing is sent, and
 * strokes map back through the transform so annotation stays exact.
 * Tools: a grouped column docked on the LEFT (FlyoutBar: hover / tap a group
 * for its options in a second column).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import {
  BACKGROUNDS,
  BATCH_MS,
  PAGE_H,
  PAGE_W,
  PALETTE,
  PointBatcher,
  currentPage,
  hitItem,
  inkFor,
  inverseOf,
  itemsInRect,
  newId,
  type Background,
  type Item,
  type Op,
} from './model';
import { LayeredRenderer, fitView, renderPageToCanvas, toPage, type View } from './render';
import { jpegsToPdf } from './pdf';
import { FlyoutBar, barBtn, type FlyoutGroup } from './FlyoutBar';
import { ZP_IDENTITY, clampZP, isZoomed, panBy, pinchZP, wheelFactor, zoomAt, type ZoomPan } from '../zoomPan';
import type { WhiteboardSession } from './session';

export type Tool = 'pen' | 'hl' | 'eraser' | 'area' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'hand';

type Props = {
  session: WhiteboardSession;
  mode: 'edit' | 'annotate' | 'view';
  identity: string;
  /** Send ops to everyone (already applied locally). */
  onSend?: (ops: Op[]) => void;
  onClose?: () => void;
  style?: CSSProperties;
  /** Small label shown in view mode while waiting for the first snapshot. */
  waitingLabel?: string;
  /** Hide the Stop button in the tool column (the host shows it elsewhere). */
  hideStop?: boolean;
};

const WIDTHS = [2, 4, 8, 14, 24];

export function WhiteboardBoard({ session, mode, identity, onSend, onClose, style, waitingLabel, hideStop }: Props) {
  const version = useSyncExternalStore(
    (fn) => session.subscribe(fn),
    () => session.version,
    () => session.version
  );
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tool, setTool] = useState<Tool>('pen');
  const page = currentPage(session.doc);
  const [color, setColor] = useState<string>(() => inkFor(page.bg));
  const [width, setWidth] = useState(4);
  // Viewer-local zoom / pan on top of the fitted page (lib/zoomPan.ts).
  const [zp, setZp] = useState<ZoomPan>(ZP_IDENTITY);
  const minZoom = mode === 'edit' ? 0.5 : 1;
  const pointers = useRef(new Map<number, [number, number]>());
  const [preview, setPreview] = useState<Item[]>([]);
  const [textAt, setTextAt] = useState<{ x: number; y: number; sx: number; sy: number } | null>(null);
  const [imgTick, setImgTick] = useState(0);
  const undoRef = useRef<{ redo: Op[]; undo: Op[] }[]>([]);
  const redoRef = useRef<{ redo: Op[]; undo: Op[] }[]>([]);
  const [, setStackTick] = useState(0);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const editing = mode !== 'view';

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

  const view: View = useMemo(() => {
    const base = fitView(size.w, size.h);
    return { scale: base.scale * zp.s, tx: base.tx * zp.s + zp.x, ty: base.ty * zp.s + zp.y };
  }, [size.w, size.h, zp]);
  const zoomBy = (factor: number, sx = size.w / 2, sy = size.h / 2) => setZp((t) => zoomAt(t, factor, sx, sy, size.w, size.h, minZoom));
  const resetZoom = () => setZp(ZP_IDENTITY);

  // Render on change only (doc, preview, size, images loading): no idle loop.
  // At most one paint per animation frame, none while the window is hidden,
  // and a cached layer for everything but the strokes still growing.
  const layered = useRef(new LayeredRenderer());
  const frame = useRef(0);
  const paintRef = useRef<() => void>(() => undefined);
  paintRef.current = () => {
    const c = canvasRef.current;
    if (!c || !size.w || !size.h) return;
    const dpr = Math.min(2, (c.ownerDocument.defaultView?.devicePixelRatio ?? 1) || 1);
    const W = Math.round(size.w * dpr), H = Math.round(size.h * dpr);
    if (c.width !== W) c.width = W;
    if (c.height !== H) c.height = H;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    layered.current.render(ctx, currentPage(session.doc), view, {
      cssW: size.w,
      cssH: size.h,
      dpr,
      extra: preview,
      onImage: () => {
        layered.current.invalidate();
        setImgTick((n) => n + 1);
      },
      structVersion: session.structVersion,
      hot: session.hotIds(),
    });
  };
  useEffect(() => {
    const c = canvasRef.current;
    const win = c?.ownerDocument.defaultView ?? null;
    if (!win) return;
    if (win.document.hidden) return; // repainted on visibilitychange
    if (frame.current) return;
    frame.current = win.requestAnimationFrame(() => {
      frame.current = 0;
      paintRef.current();
    });
  }, [version, preview, size.w, size.h, view, imgTick, session]);
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

  // Perform an op, computing its inverse for undo.
  const act = useCallback(
    (op: Op) => {
      const before = 'p' in op ? JSON.parse(JSON.stringify(session.doc.pages.find((p) => p.id === (op as { p: string }).p) ?? null)) : undefined;
      const undo = inverseOf(op, before ?? undefined, session.doc);
      send([op], { undo });
    },
    [send, session]
  );

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

  // ---- pointer drawing ----
  const drag = useRef<{
    kind: Tool;
    batcher?: PointBatcher;
    item?: Item;
    start?: { x: number; y: number };
    erased?: Set<string>;
    panFrom?: { x: number; y: number; t: ZoomPan };
    timer?: number;
  } | null>(null);

  const mine = useCallback((it: Item) => mode === 'edit' || it.by === identity, [mode, identity]);

  const pagePoint = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return toPage(view, e.clientX - r.left, e.clientY - r.top);
  };

  const flushPts = () => {
    const d = drag.current;
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

  const onDown = (e: React.PointerEvent) => {
    if (textAt) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size >= 2) {
      // Second finger: pinch-zoom / two-finger pan (any mode). A stroke the
      // first finger just started is kept as drawn so far.
      const d = drag.current;
      if (d?.batcher) {
        window.clearInterval(d.timer);
        flushPts();
      }
      setPreview([]);
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
    if (t === 'pen' || t === 'hl') {
      const id = newId(mode === 'edit' ? 't' : 's');
      const w = t === 'hl' ? width * 3 : width;
      const item: Item = { k: 'stroke', id, by: identity, tool: t, c: color, w, pts: [Math.round(pt.x), Math.round(pt.y)] };
      send([{ k: 'add', p: pg.id, item }]);
      const batcher = new PointBatcher(pg.id, id);
      const timer = window.setInterval(flushPts, BATCH_MS);
      drag.current = { kind: t, batcher, item, timer };
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
    drag.current = { kind: t, start: pt };
  };

  const onMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (prev && pointers.current.size >= 2) {
      const next = local(e);
      const other = [...pointers.current.entries()].find(([id]) => id !== e.pointerId)?.[1];
      pointers.current.set(e.pointerId, next);
      if (other) setZp((t) => pinchZP(t, prev, other, next, other, size.w, size.h, minZoom));
      return;
    }
    if (prev) pointers.current.set(e.pointerId, local(e));
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'hand') {
      if (d.panFrom) setZp(panBy(d.panFrom.t, e.clientX - d.panFrom.x, e.clientY - d.panFrom.y, size.w, size.h, minZoom));
      return;
    }
    const pt = pagePoint(e);
    if (d.batcher) {
      d.batcher.push(pt.x, pt.y);
      return;
    }
    if (d.kind === 'eraser') return eraseAt(pt.x, pt.y);
    if (d.start) {
      const s = d.start;
      const id = 'preview';
      if (d.kind === 'area') {
        setPreview([{ k: 'rect', id, by: identity, c: '#e53935', w: 2 / view.scale, x1: s.x, y1: s.y, x2: pt.x, y2: pt.y }]);
      } else if (d.kind === 'line' || d.kind === 'arrow' || d.kind === 'rect' || d.kind === 'ellipse') {
        setPreview([{ k: d.kind, id, by: identity, c: color, w: width, x1: s.x, y1: s.y, x2: pt.x, y2: pt.y }]);
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
      flushPts();
      const full = pg.items.find((x) => x.id === d.item!.id);
      if (full) {
        undoRef.current.push({ redo: [{ k: 'add', p: pg.id, item: JSON.parse(JSON.stringify(full)) }], undo: [{ k: 'del', p: pg.id, ids: [full.id] }] });
        redoRef.current = [];
        setStackTick((n) => n + 1);
      }
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
      if (d.kind === 'line' || d.kind === 'arrow' || d.kind === 'rect' || d.kind === 'ellipse') {
        act({
          k: 'add',
          p: pg.id,
          item: { k: d.kind, id: newId('t'), by: identity, c: color, w: width, x1: Math.round(d.start.x), y1: Math.round(d.start.y), x2: Math.round(pt.x), y2: Math.round(pt.y) },
        });
      }
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    // Teacher: Ctrl+wheel (plain wheel is free for the page). Viewers: wheel zooms.
    if (mode === 'edit' && !(e.ctrlKey || e.metaKey)) return;
    const [sx, sy] = local(e);
    zoomBy(wheelFactor(e.deltaY, e.deltaMode), sx, sy);
  };
  // Keep the transform valid when the box resizes.
  useEffect(() => {
    if (size.w && size.h) setZp((t) => clampZP(t, size.w, size.h, minZoom));
  }, [size.w, size.h, minZoom]);

  // Keyboard shortcuts (edit).
  useEffect(() => {
    if (mode === 'view') return;
    const win = wrapRef.current?.ownerDocument.defaultView ?? window;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (mode === 'edit' && e.key === 'PageDown') goPage(1);
      else if (mode === 'edit' && e.key === 'PageUp') goPage(-1);
    };
    win.addEventListener('keydown', onKey);
    return () => win.removeEventListener('keydown', onKey);
  });

  const goPage = (delta: number) => {
    const cur = session.doc.cur + delta;
    if (cur < 0 || cur >= session.doc.pages.length) return;
    act({ k: 'go', cur });
  };
  const newPage = () => act({ k: 'newpage', at: session.doc.cur + 1, id: newId('p'), bg: currentPage(session.doc).bg });
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

  const insertImage = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1280;
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k));
        c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
        const src = c.toDataURL('image/jpeg', 0.8);
        const fit = Math.min(1, (PAGE_W * 0.7) / c.width, (PAGE_H * 0.7) / c.height);
        const w = Math.round(c.width * fit), h = Math.round(c.height * fit);
        act({ k: 'add', p: currentPage(session.doc).id, item: { k: 'img', id: newId('t'), by: identity, src, x: Math.round((PAGE_W - w) / 2), y: Math.round((PAGE_H - h) / 2), w, h } });
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const download = (name: string, url: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  const exportPng = () => {
    const c = document.createElement('canvas');
    renderPageToCanvas(currentPage(session.doc), c);
    download(`whiteboard-page-${session.doc.cur + 1}.png`, c.toDataURL('image/png'));
  };
  const exportPdf = async () => {
    const pages: { jpeg: Uint8Array; w: number; h: number }[] = [];
    for (const p of session.doc.pages) {
      const c = document.createElement('canvas');
      renderPageToCanvas(p, c);
      const blob: Blob | null = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9));
      if (blob) pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: PAGE_W, h: PAGE_H });
    }
    const pdf = jpegsToPdf(pages);
    const url = URL.createObjectURL(new Blob([pdf as BlobPart], { type: 'application/pdf' }));
    download('whiteboard.pdf', url);
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const cursor = !editing ? (isZoomed(zp) ? 'grab' : 'default') : tool === 'hand' ? 'grab' : tool === 'text' ? 'text' : 'crosshair';
  const btn = (active: boolean): CSSProperties => barBtn(active, { minWidth: 36, height: 36, fontSize: 14 });
  const toolBtn = (t: Tool, label: string, title: string) => (
    <button key={t} type="button" title={title} aria-label={title} data-wb-tool={t} style={btn(tool === t)} onClick={() => setTool(t)}>
      {label}
    </button>
  );
  const isTool = (...ts: Tool[]) => ts.includes(tool);
  const glyph = (g: string) => <span aria-hidden style={{ fontSize: 17, lineHeight: 1 }}>{g}</span>;
  const colorGrid = (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 26px)', gap: 6 }}>
        {PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            title={`Colour ${c}`}
            aria-label={`Colour ${c}`}
            onClick={() => setColor(c)}
            style={{ width: 26, height: 26, borderRadius: 13, background: c, border: color === c ? '3px solid #60a5fa' : '1px solid #475569', cursor: 'pointer', padding: 0 }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }} role="radiogroup" aria-label="Thickness">
        {WIDTHS.map((w) => (
          <button key={w} type="button" role="radio" aria-checked={width === w} aria-label={`Thickness ${w}px`} title={`${w}px`} onClick={() => setWidth(w)} style={btn(width === w)}>
            <span style={{ width: Math.min(18, w + 2), height: Math.min(18, w + 2), borderRadius: 9, background: color, display: 'block' }} />
          </button>
        ))}
      </div>
    </>
  );
  const undoRedo = (
    <>
      <button type="button" style={btn(false)} onClick={undo} title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!undoRef.current.length}>
        ↶
      </button>
      <button type="button" style={btn(false)} onClick={redo} title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!redoRef.current.length}>
        ↷
      </button>
    </>
  );
  const editGroups: FlyoutGroup[] = [
    {
      id: 'draw',
      label: 'Draw: pen, highlighter, text',
      icon: glyph(tool === 'hl' ? '▬' : tool === 'text' ? 'T' : '✎'),
      active: isTool('pen', 'hl', 'text'),
      testId: 'wb-group-draw',
      content: (
        <>
          {toolBtn('pen', '✎', 'Pen')}
          {toolBtn('hl', '▬', 'Highlighter')}
          {toolBtn('text', 'T', 'Text')}
        </>
      ),
    },
    {
      id: 'shapes',
      label: 'Shapes: line, arrow, rectangle, ellipse',
      icon: glyph(tool === 'line' ? '╱' : tool === 'arrow' ? '➚' : tool === 'ellipse' ? '◯' : '▭'),
      active: isTool('line', 'arrow', 'rect', 'ellipse'),
      content: (
        <>
          {toolBtn('line', '╱', 'Line')}
          {toolBtn('arrow', '➚', 'Arrow')}
          {toolBtn('rect', '▭', 'Rectangle')}
          {toolBtn('ellipse', '◯', 'Ellipse')}
        </>
      ),
    },
    {
      id: 'erase',
      label: 'Erase and undo',
      icon: glyph('⌫'),
      active: isTool('eraser', 'area'),
      content: (
        <>
          {toolBtn('eraser', '⌫', 'Eraser (strokes)')}
          {toolBtn('area', '⬚', 'Eraser (area)')}
          {undoRedo}
          <button type="button" style={btn(false)} onClick={() => act({ k: 'clear', p: currentPage(session.doc).id })} title="Clear page" aria-label="Clear page">
            Clear
          </button>
        </>
      ),
    },
    {
      id: 'color',
      label: 'Colour and size',
      icon: <span aria-hidden style={{ width: 18, height: 18, borderRadius: 9, background: color, border: '2px solid #e2e8f0', display: 'block' }} />,
      content: colorGrid,
    },
    {
      id: 'pages',
      label: 'Pages and background',
      icon: <span aria-hidden style={{ fontSize: 11 }} data-testid="wb-page">{session.doc.cur + 1}/{session.doc.pages.length}</span>,
      content: (
        <>
          <button type="button" style={btn(false)} onClick={() => goPage(-1)} disabled={session.doc.cur === 0} aria-label="Previous page" title="Previous page (PgUp)">
            ‹
          </button>
          <button type="button" style={btn(false)} onClick={() => goPage(1)} disabled={session.doc.cur >= session.doc.pages.length - 1} aria-label="Next page" title="Next page (PgDn)">
            ›
          </button>
          <button type="button" style={btn(false)} onClick={newPage} aria-label="New page" title="New page">
            +Page
          </button>
          {BACKGROUNDS.map((b) => (
            <button key={b} type="button" style={btn(page.bg === b)} onClick={() => setBg(b)} aria-label={`Background ${b}`} title={`Background: ${b}`}>
              {b[0]!.toUpperCase() + b.slice(1)}
            </button>
          ))}
        </>
      ),
    },
    {
      id: 'view',
      label: 'Zoom, pan, image and export',
      icon: glyph('⌕'),
      active: isTool('hand'),
      content: (
        <>
          {toolBtn('hand', '✋', 'Pan')}
          <button type="button" style={btn(false)} onClick={() => zoomBy(1 / 1.25)} aria-label="Zoom out" title="Zoom out (Ctrl+wheel)">
            −
          </button>
          <button type="button" style={btn(false)} onClick={resetZoom} aria-label="Fit page" title="Fit page">
            {Math.round(zp.s * 100)}%
          </button>
          <button type="button" style={btn(false)} onClick={() => zoomBy(1.25)} aria-label="Zoom in" title="Zoom in">
            +
          </button>
          <button type="button" style={btn(false)} onClick={() => fileRef.current?.click()} aria-label="Insert image" title="Insert image">
            🖼
          </button>
          <button type="button" style={btn(false)} onClick={exportPng} aria-label="Export PNG" title="Export this page as PNG">
            PNG
          </button>
          <button type="button" style={btn(false)} onClick={() => void exportPdf()} aria-label="Export PDF" title="Export all pages as PDF">
            PDF
          </button>
        </>
      ),
    },
  ];
  const annotateGroups: FlyoutGroup[] = [
    { id: 'pen', label: 'Pen', icon: glyph('✎'), active: tool !== 'eraser', onClick: () => setTool('pen') },
    { id: 'eraser', label: 'Erase my drawing', icon: glyph('⌫'), active: tool === 'eraser', onClick: () => setTool('eraser') },
    { id: 'color', label: 'Colour and size', icon: <span aria-hidden style={{ width: 18, height: 18, borderRadius: 9, background: color, border: '2px solid #e2e8f0', display: 'block' }} />, content: colorGrid },
    { id: 'undo', label: 'Undo / redo', icon: glyph('↶'), content: undoRedo },
  ];
  const barW = 54;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#0b0f14', overflow: 'hidden', ...style }} data-whiteboard={mode}>
      <div ref={wrapRef} style={{ position: 'absolute', inset: 0, left: mode === 'view' ? 0 : barW }}>
        <canvas
          ref={canvasRef}
          data-testid="wb-canvas"
          style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none', cursor }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onWheel={onWheel}
        />
        {mode === 'view' && !session.ready && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#94a3b8', fontSize: 14 }}>{waitingLabel ?? 'Loading whiteboard…'}</div>
        )}
        {mode !== 'edit' && isZoomed(zp) && (
          <button type="button" data-testid="wb-reset-zoom" onClick={resetZoom} style={{ ...btn(false), position: 'absolute', right: 10, bottom: 10, zIndex: 4, background: 'rgba(17,24,39,0.9)', padding: '0 12px' }}>
            Reset zoom
          </button>
        )}
        {textAt && (
          <textarea
            autoFocus
            data-testid="wb-text"
            style={{ position: 'absolute', left: textAt.sx, top: textAt.sy, minWidth: 200, minHeight: 40, font: `${(24 + width * 4) * view.scale}px system-ui`, color, background: 'rgba(255,255,255,0.85)', border: '1px dashed #2563eb', outline: 'none', zIndex: 3 }}
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
                ■
              </button>
            ) : undefined
          }
        />
      )}
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) insertImage(f); e.target.value = ''; }} />
    </div>
  );
}

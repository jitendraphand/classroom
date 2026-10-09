'use client';

/**
 * Student drawing on the teacher's shared screen: shared state (strokes +
 * holder), the overlay everyone sees, and the drawing surface + toolbar of
 * the allowed student. Rules and the overview: lib/drawLogic.ts.
 */
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { roomFetch } from '@/lib/classroomClient';
import { cn } from '@/lib/cn';
import {
  DRAW_COLORS,
  DRAW_COLOR_NAMES,
  DRAW_TOPIC,
  applyPacket,
  containRect,
  createPointBatcher,
  decodePacket,
  hitStroke,
  desktopInkShown,
  holderActive,
  lastStrokeOf,
  nameTags,
  strokeWidthFor,
  toNorm,
  type DrawColor,
  type DrawHolder,
  type Stroke,
} from '@/lib/drawLogic';
import { IconEraser, IconPen, IconUndo } from '@/components/ui/Icons';

type DrawingCtx = {
  strokes: Stroke[];
  holder: DrawHolder | null;
  /** My LiveKit identity (student) — to know which strokes I may erase. */
  myIdentity: string;
  canDraw: boolean;
  /** The share already shows the ink (teacher's Windows app draws it on the desktop). */
  desktopInk: boolean;
  /** Stroke id -> ms of my last local point (desktop ink fade). */
  touched: Map<string, number>;
  setStrokes: (fn: (s: Stroke[]) => Stroke[]) => void;
  post: (body: Record<string, unknown>) => Promise<Response | null>;
};

const Ctx = createContext<DrawingCtx | null>(null);

export function useShareDrawing() {
  return useContext(Ctx);
}

/**
 * Holds the strokes for this tab. Mount inside <LiveKitRoom>. `active` =
 * the teacher is sharing (strokes are wiped when the share stops).
 */
export function ShareDrawingProvider({
  code,
  active,
  holder,
  myIdentity,
  canDraw,
  desktopInk = false,
  children,
}: {
  code: string;
  active: boolean;
  holder: DrawHolder | null | undefined;
  myIdentity: string;
  canDraw: boolean;
  desktopInk?: boolean;
  children: ReactNode;
}) {
  const touched = useRef(new Map<string, number>()).current;
  const room = useRoomContext();
  const [strokes, setStrokesState] = useState<Stroke[]>([]);
  const setStrokes = useCallback((fn: (s: Stroke[]) => Stroke[]) => setStrokesState(fn), []);
  const meRef = useRef(myIdentity);
  meRef.current = myIdentity;

  const post = useCallback(
    async (body: Record<string, unknown>) => {
      try {
        return await roomFetch(code, '/draw', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch {
        return null;
      }
    },
    [code]
  );

  // Snapshot for late joiners / reconnects / share (re)start.
  const load = useCallback(async () => {
    try {
      const res = await roomFetch(code, '/draw', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { strokes?: Stroke[] };
      // Packets that arrived meanwhile are re-applied idempotently by index.
      setStrokesState(Array.isArray(data.strokes) ? data.strokes : []);
    } catch {
      /* next nudge / reconnect retries */
    }
  }, [code]);

  useEffect(() => {
    if (!active) {
      setStrokesState([]);
      return;
    }
    void load();
  }, [active, load]);

  useEffect(() => {
    if (!room) return;
    const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
    const onData = (payload: Uint8Array, participant?: unknown, _k?: unknown, topic?: string) => {
      // Only the server sends `draw`; a packet naming a participant is forged.
      if (topic !== DRAW_TOPIC || participant || !decoder) return;
      try {
        const p = decodePacket(JSON.parse(decoder.decode(payload)));
        if (!p) return;
        // My own points are already drawn locally (an echo could briefly cut
        // the points drawn since that batch).
        if (p.t === 'pts' && p.by === meRef.current) return;
        setStrokesState((s) => applyPacket(s, p));
      } catch {
        /* ignore */
      }
    };
    const onReconnected = () => void load();
    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.Reconnected, onReconnected);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.Reconnected, onReconnected);
    };
  }, [room, load]);

  const value = useMemo<DrawingCtx>(
    () => ({
      strokes: active ? strokes : [],
      holder: holderActive(holder ?? null) ? (holder as DrawHolder) : null,
      myIdentity,
      canDraw: active && canDraw,
      desktopInk: active && desktopInk,
      touched,
      setStrokes,
      post,
    }),
    [active, strokes, holder, myIdentity, canDraw, desktopInk, touched, setStrokes, post]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Track the picture box of the <video> inside `host` (object-fit: contain). */
function usePictureRect(host: HTMLElement | null, aspect?: number) {
  const [rect, setRect] = useState({ x: 0, y: 0, w: 0, h: 0 });
  useLayoutEffect(() => {
    if (!host) return;
    // The share-controls window has its own timers/observers: the classroom
    // tab may be hidden (its rAF paused) while the teacher presents.
    const win = (host.ownerDocument.defaultView ?? window) as Window & typeof globalThis;
    let raf = 0;
    const measure = () => {
      win.cancelAnimationFrame(raf);
      raf = win.requestAnimationFrame(() => {
        const r = host.getBoundingClientRect();
        const v = host.querySelector('video');
        const vw = v?.videoWidth || (aspect ? aspect * 1000 : 0);
        const vh = v?.videoHeight || (aspect ? 1000 : 0);
        const next = containRect(r.width, r.height, vw, vh);
        setRect((p) =>
          Math.abs(p.x - next.x) < 0.5 && Math.abs(p.y - next.y) < 0.5 && Math.abs(p.w - next.w) < 0.5 && Math.abs(p.h - next.h) < 0.5
            ? p
            : next
        );
      });
    };
    measure();
    const RO = win.ResizeObserver ?? (typeof ResizeObserver !== 'undefined' ? ResizeObserver : undefined);
    const ro = RO ? new RO(measure) : null;
    ro?.observe(host);
    let v = host.querySelector('video');
    const bindVideo = () => {
      const nv = host.querySelector('video');
      if (nv === v) return;
      v?.removeEventListener('resize', measure);
      v?.removeEventListener('loadedmetadata', measure);
      v = nv;
      v?.addEventListener('resize', measure);
      v?.addEventListener('loadedmetadata', measure);
    };
    v?.addEventListener('resize', measure);
    v?.addEventListener('loadedmetadata', measure);
    // The <video> may mount after us (track subscribed later).
    const MO = win.MutationObserver ?? (typeof MutationObserver !== 'undefined' ? MutationObserver : undefined);
    const mo = MO
      ? new MO(() => {
          bindVideo();
          measure();
        })
      : null;
    mo?.observe(host, { childList: true });
    const id = win.setInterval(measure, 1500);
    return () => {
      win.cancelAnimationFrame(raf);
      ro?.disconnect();
      mo?.disconnect();
      v?.removeEventListener('resize', measure);
      v?.removeEventListener('loadedmetadata', measure);
      win.clearInterval(id);
    };
  }, [host, aspect]);
  return rect;
}

function StrokesSvg({ strokes, w, h }: { strokes: Stroke[]; w: number; h: number }) {
  const sw = strokeWidthFor(w);
  return (
    <svg className="draw-svg" width={w} height={h} viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
      {strokes.map((s) =>
        s.pts.length <= 2 ? (
          <circle key={s.id} cx={s.pts[0]} cy={s.pts[1]} r={sw / 2 / Math.max(1, w)} fill={DRAW_COLORS[s.color]} />
        ) : (
          <polyline
            key={s.id}
            points={pairs(s.pts)}
            fill="none"
            stroke={DRAW_COLORS[s.color]}
            strokeWidth={sw}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )
      )}
    </svg>
  );
}

function pairs(p: number[]) {
  let out = '';
  for (let i = 0; i + 1 < p.length; i += 2) out += `${p[i]},${p[i + 1]} `;
  return out;
}

/**
 * Strokes over a shared-screen video. Place as the LAST child of the
 * positioned element that contains the <video> (object-contain). With no
 * video (teacher's entire-screen card), pass `aspect` to draw on a dark box.
 */
export function DrawOverlay({ aspect, interactive = true, className }: { aspect?: number; interactive?: boolean; className?: string }) {
  const d = useShareDrawing();
  const ref = useRef<HTMLDivElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setHost(ref.current?.parentElement ?? null), []);
  const rect = usePictureRect(host, aspect);
  const [, fadeTick] = useState(0);
  const shown = d
    ? desktopInkShown(d.strokes, { desktopInk: d.desktopInk, me: d.myIdentity, touched: d.touched, now: Date.now() })
    : [];
  const fading = !!d?.desktopInk && shown.length > 0;
  // Desktop ink: re-render until my local copy has faded (the video shows it).
  useEffect(() => {
    if (!fading) return;
    const t = window.setTimeout(() => fadeTick((n) => n + 1), 250);
    return () => window.clearTimeout(t);
  });
  if (!d) return <div ref={ref} hidden />;
  const show = shown.length > 0 || (interactive && d.canDraw);
  return (
    <div ref={ref} className={cn('draw-layer', className)} data-draw-layer>
      {show && rect.w > 0 && (
        <div className="draw-pic" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
          <StrokesSvg strokes={shown} w={rect.w} h={rect.h} />
          {(d.desktopInk ? [] : nameTags(shown)).map((t) => (
            <span
              key={t.by}
              className="draw-name"
              style={{ left: `${t.x * 100}%`, top: `${t.y * 100}%`, borderColor: DRAW_COLORS[t.color] }}
            >
              {t.by === d.myIdentity ? 'You' : t.name}
            </span>
          ))}
          {interactive && d.canDraw && <DrawSurface w={rect.w} h={rect.h} />}
        </div>
      )}
    </div>
  );
}

function newId() {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'[b & 63]).join('');
}

/** The allowed student's input layer + toolbar. Mouse, pen and touch alike (Pointer Events). */
function DrawSurface({ w, h }: { w: number; h: number }) {
  const d = useShareDrawing()!;
  const [color, setColor] = useState<DrawColor>('red');
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen');
  const [error, setError] = useState('');
  const cur = useRef<{ id: string; pointer: number; lx: number; ly: number } | null>(null);
  const strokesRef = useRef(d.strokes);
  strokesRef.current = d.strokes;

  const batcher = useMemo(
    () =>
      createPointBatcher(async (b) => {
        const res = await d.post({ action: 'pts', id: b.id, from: b.from, pts: b.pts, color: b.color });
        if (res && !res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setError(data.error || 'Could not send the drawing');
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [d.post]
  );

  const erase = (id: string | null) => {
    if (!id) return;
    d.setStrokes((s) => s.filter((x) => x.id !== id));
    void d.post({ action: 'del', id });
  };

  const point = (e: React.PointerEvent<HTMLDivElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return toNorm(e.clientX - r.left, e.clientY - r.top, { x: 0, y: 0, w: r.width, h: r.height });
  };

  const addPts = (pts: number[]) => {
    const c = cur.current;
    if (!c || !pts.length) return;
    const id = c.id;
    d.touched.set(id, Date.now());
    d.setStrokes((s) => {
      const i = s.findIndex((x) => x.id === id);
      if (i < 0) return [...s, { id, by: d.myIdentity, name: 'You', color, pts }];
      const next = s.slice();
      next[i] = { ...s[i]!, pts: [...s[i]!.pts, ...pts] };
      return next;
    });
    batcher.add(id, color, pts);
  };

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== undefined && e.button > 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const [x, y] = point(e);
    setError('');
    if (tool === 'eraser') {
      cur.current = { id: '', pointer: e.pointerId, lx: x, ly: y };
      erase(hitStroke(strokesRef.current, d.myIdentity, x, y, 0.025, w / Math.max(1, h)));
      return;
    }
    cur.current = { id: newId(), pointer: e.pointerId, lx: x, ly: y };
    addPts([x, y]);
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const c = cur.current;
    if (!c || c.pointer !== e.pointerId) return;
    e.preventDefault();
    const events = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [e.nativeEvent];
    const r = e.currentTarget.getBoundingClientRect();
    const pts: number[] = [];
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const [x, y] = toNorm(ev.clientX - r.left, ev.clientY - r.top, { x: 0, y: 0, w: r.width, h: r.height });
      if (tool === 'eraser') {
        erase(hitStroke(strokesRef.current, d.myIdentity, x, y, 0.025, w / Math.max(1, h)));
        continue;
      }
      // Skip sub-pixel jitter (same density on every screen size).
      if (Math.hypot((x - c.lx) * w, (y - c.ly) * h) < 2) continue;
      c.lx = x;
      c.ly = y;
      pts.push(x, y);
    }
    if (pts.length) addPts(pts);
  };

  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (cur.current?.pointer === e.pointerId) cur.current = null;
  };

  const left = d.holder ? Math.max(0, Math.round((d.holder.until - Date.now()) / 1000)) : 0;
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <>
      <div
        className={cn('draw-surface', tool === 'eraser' && 'is-eraser')}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onContextMenu={(e) => e.preventDefault()}
        role="application"
        aria-label="Draw on the shared screen"
      />
      <div className="draw-toolbar" role="toolbar" aria-label="Drawing tools">
        <span className="draw-toolbar-label">
          <IconPen size={14} /> {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
        </span>
        {DRAW_COLOR_NAMES.map((c) => (
          <button
            key={c}
            type="button"
            className={cn('draw-color', tool === 'pen' && color === c && 'is-on')}
            style={{ background: DRAW_COLORS[c] }}
            aria-label={`${c} pen`}
            aria-pressed={tool === 'pen' && color === c}
            onClick={() => {
              setColor(c);
              setTool('pen');
            }}
          />
        ))}
        <button
          type="button"
          className={cn('draw-tool', tool === 'eraser' && 'is-on')}
          aria-label="Eraser (your strokes)"
          aria-pressed={tool === 'eraser'}
          onClick={() => setTool((t) => (t === 'eraser' ? 'pen' : 'eraser'))}
        >
          <IconEraser size={16} />
        </button>
        <button
          type="button"
          className="draw-tool"
          aria-label="Undo your last stroke"
          disabled={!lastStrokeOf(d.strokes, d.myIdentity)}
          onClick={() => erase(lastStrokeOf(strokesRef.current, d.myIdentity))}
        >
          <IconUndo size={16} />
        </button>
        <button type="button" className="draw-done" onClick={() => void d.post({ action: 'release' })}>
          Done
        </button>
      </div>
      {error && <div className="draw-error">{error}</div>}
    </>
  );
}

/** Teacher: "Clear drawing" (shared by the in-page stage and share controls). */
export function useDrawingActions(code: string) {
  const call = useCallback(
    async (body: Record<string, unknown>) => {
      const res = await roomFetch(code, '/draw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => null);
      if (!res) return 'Network error';
      if (res.ok) return null;
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return data.error || `Failed (${res.status})`;
    },
    [code]
  );
  return {
    allow: (participantId: string) => call({ action: 'allow', participantId }),
    revoke: (participantId?: string) => call({ action: 'revoke', participantId }),
    clear: () => call({ action: 'clear' }),
    request: (on: boolean) => call({ action: on ? 'request' : 'cancel' }),
  };
}

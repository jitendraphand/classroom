'use client';

/**
 * Teacher marks on the shared picture. The Windows app draws on a capture
 * overlay; a browser cannot, so the same marks are an SVG on the in-tab
 * preview and on every student's view of that picture.
 */
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, type RemoteParticipant } from 'livekit-client';
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
import { containRect, toNorm } from '@/lib/drawLogic';
import { parseOrient, toolWidth, type BarOrient } from '@/lib/shareChrome';
import {
  TINK_TOPIC,
  applyInk,
  arrowHead,
  decodeInk,
  hitAnyPts,
  shapePts,
  type InkKind,
  type InkMsg,
  type InkStroke,
} from '@/lib/teacherInk';
import { useShareDrawing } from './ShareDrawing';

const ORIENT_KEY = 'classroom.annotateOrient';

type Tool = InkKind | 'eraser';
type UndoEntry = { t: 'add'; stroke: InkStroke } | { t: 'del'; stroke: InkStroke };

export type TeacherInkApi = {
  annotating: boolean;
  setAnnotating: (on: boolean) => void;
  tool: Tool;
  setTool: (t: Tool) => void;
  color: string;
  setColor: (c: string) => void;
  thickness: number;
  setThickness: (n: number) => void;
  strokes: InkStroke[];
  upsert: (stroke: InkStroke, commit?: boolean) => void;
  remove: (id: string) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  clear: () => void;
  orient: BarOrient;
  setOrient: (o: BarOrient) => void;
};

const Ctx = createContext<TeacherInkApi | null>(null);

export function useTeacherInk() {
  return useContext(Ctx);
}

function newId() {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'[b & 63]).join('');
}

function pairs(p: number[]) {
  let out = '';
  for (let i = 0; i + 1 < p.length; i += 2) out += `${p[i]},${p[i + 1]} `;
  return out;
}

function ellipseBox(pts: number[]) {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    minX = Math.min(minX, pts[i]!);
    maxX = Math.max(maxX, pts[i]!);
    minY = Math.min(minY, pts[i + 1]!);
    maxY = Math.max(maxY, pts[i + 1]!);
  }
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, rx: Math.abs(maxX - minX) / 2, ry: Math.abs(maxY - minY) / 2 };
}

export function TeacherInkProvider({
  active,
  publish: canPublish,
  children,
}: {
  /** Share is up. Strokes clear when it stops. */
  active: boolean;
  /** Only the teacher publishes. Everyone else applies. */
  publish: boolean;
  children: ReactNode;
}) {
  const room = useRoomContext();
  const [annotating, setAnnotatingState] = useState(false);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState('#ef4444');
  const [thickness, setThickness] = useState(3);
  const [strokes, setStrokes] = useState<InkStroke[]>([]);
  const [hist, setHist] = useState(0);
  const [orient, setOrientState] = useState<BarOrient>('horizontal');
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;
  const undoRef = useRef<UndoEntry[]>([]);
  const redoRef = useRef<UndoEntry[]>([]);
  const committed = useRef(new Set<string>());
  const pubTimer = useRef<number | null>(null);
  const pubPending = useRef<InkMsg | null>(null);

  useEffect(() => {
    try {
      setOrientState(parseOrient(sessionStorage.getItem(ORIENT_KEY)));
    } catch {
      /* ignore */
    }
  }, []);

  const send = useCallback(
    (msg: InkMsg) => {
      if (!canPublish || !room || room.state !== 'connected') return;
      const data = new TextEncoder().encode(JSON.stringify(msg));
      void room.localParticipant
        .publishData(data as Uint8Array<ArrayBuffer>, { reliable: true, topic: TINK_TOPIC })
        .catch(() => undefined);
    },
    [canPublish, room]
  );

  const publishMsg = useCallback(
    (msg: InkMsg, now = false) => {
      if (!canPublish) return;
      if (now) {
        if (pubTimer.current !== null) window.clearTimeout(pubTimer.current);
        pubTimer.current = null;
        pubPending.current = null;
        send(msg);
        return;
      }
      pubPending.current = msg;
      if (pubTimer.current !== null) return;
      pubTimer.current = window.setTimeout(() => {
        pubTimer.current = null;
        const pending = pubPending.current;
        pubPending.current = null;
        if (pending) send(pending);
      }, 80);
    },
    [canPublish, send]
  );

  const setOrient = useCallback((o: BarOrient) => {
    setOrientState(o);
    try {
      sessionStorage.setItem(ORIENT_KEY, o);
    } catch {
      /* ignore */
    }
  }, []);

  const clearLocal = useCallback(() => {
    setStrokes([]);
    undoRef.current = [];
    redoRef.current = [];
    committed.current.clear();
    setHist((n) => n + 1);
  }, []);

  useEffect(() => {
    if (active) return;
    clearLocal();
    setAnnotatingState(false);
  }, [active, clearLocal]);

  useEffect(() => {
    if (!room) return;
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _k?: unknown, topic?: string) => {
      if (topic !== TINK_TOPIC || !participant || participant.isLocal) return;
      if (!participant.identity.startsWith('teacher_')) return;
      try {
        const msg = decodeInk(JSON.parse(new TextDecoder().decode(payload)));
        if (msg) setStrokes((s) => applyInk(s, msg));
      } catch {
        /* ignore */
      }
    };
    const onJoin = () => {
      if (!canPublish || !strokesRef.current.length) return;
      send({ v: 1, t: 'snap', strokes: strokesRef.current });
    };
    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.ParticipantConnected, onJoin);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.ParticipantConnected, onJoin);
    };
  }, [room, canPublish, send]);

  const upsert = useCallback(
    (stroke: InkStroke, commit = false) => {
      setStrokes((s) => applyInk(s, { v: 1, t: 'up', stroke }));
      publishMsg({ v: 1, t: 'up', stroke }, commit);
      if (commit && !committed.current.has(stroke.id)) {
        committed.current.add(stroke.id);
        undoRef.current.push({ t: 'add', stroke: { ...stroke, pts: stroke.pts.slice() } });
        redoRef.current = [];
        setHist((n) => n + 1);
      }
    },
    [publishMsg]
  );

  const remove = useCallback(
    (id: string) => {
      const stroke = strokesRef.current.find((s) => s.id === id);
      if (!stroke) return;
      setStrokes((s) => applyInk(s, { v: 1, t: 'del', id }));
      publishMsg({ v: 1, t: 'del', id }, true);
      committed.current.delete(id);
      undoRef.current.push({ t: 'del', stroke: { ...stroke, pts: stroke.pts.slice() } });
      redoRef.current = [];
      setHist((n) => n + 1);
    },
    [publishMsg]
  );

  const undo = useCallback(() => {
    const entry = undoRef.current.pop();
    if (!entry) return;
    if (entry.t === 'add') {
      setStrokes((s) => applyInk(s, { v: 1, t: 'del', id: entry.stroke.id }));
      publishMsg({ v: 1, t: 'del', id: entry.stroke.id }, true);
      committed.current.delete(entry.stroke.id);
    } else {
      setStrokes((s) => applyInk(s, { v: 1, t: 'up', stroke: entry.stroke }));
      publishMsg({ v: 1, t: 'up', stroke: entry.stroke }, true);
      committed.current.add(entry.stroke.id);
    }
    redoRef.current.push(entry);
    setHist((n) => n + 1);
  }, [publishMsg]);

  const redo = useCallback(() => {
    const entry = redoRef.current.pop();
    if (!entry) return;
    if (entry.t === 'add') {
      setStrokes((s) => applyInk(s, { v: 1, t: 'up', stroke: entry.stroke }));
      publishMsg({ v: 1, t: 'up', stroke: entry.stroke }, true);
      committed.current.add(entry.stroke.id);
    } else {
      setStrokes((s) => applyInk(s, { v: 1, t: 'del', id: entry.stroke.id }));
      publishMsg({ v: 1, t: 'del', id: entry.stroke.id }, true);
      committed.current.delete(entry.stroke.id);
    }
    undoRef.current.push(entry);
    setHist((n) => n + 1);
  }, [publishMsg]);

  const clear = useCallback(() => {
    clearLocal();
    publishMsg({ v: 1, t: 'clear' }, true);
  }, [clearLocal, publishMsg]);

  const setAnnotating = useCallback(
    (on: boolean) => {
      setAnnotatingState(on);
      if (!on) {
        clearLocal();
        publishMsg({ v: 1, t: 'clear' }, true);
      }
    },
    [clearLocal, publishMsg]
  );

  // Proper undo/redo with the stroke body kept on every entry. The callbacks
  // above are replaced by these once the stacks hold strokes. See api memo.
  const api = useMemo<TeacherInkApi>(
    () => ({
      annotating,
      setAnnotating,
      tool,
      setTool,
      color,
      setColor,
      thickness,
      setThickness,
      strokes,
      upsert,
      remove,
      undo,
      redo,
      canUndo: undoRef.current.length > 0,
      canRedo: redoRef.current.length > 0,
      clear,
      orient,
      setOrient,
    }),
    // hist bumps when the undo stacks change (they live in refs).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [annotating, setAnnotating, tool, color, thickness, strokes, upsert, remove, undo, redo, hist, clear, orient, setOrient]
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/**
 * Marks over a shared-screen video. `interactive` is the teacher's own
 * preview while annotate is on. Students render the same strokes and never
 * get a pointer target here.
 */
export function TeacherInkOverlay({ interactive = false }: { interactive?: boolean }) {
  const ink = useTeacherInk();
  const draw = useShareDrawing();
  const ref = useRef<HTMLDivElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [rect, setRect] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const cur = useRef<{ id: string; pointer: number; kind: InkKind; x0: number; y0: number; pts: number[] } | null>(null);
  useLayoutEffect(() => setHost(ref.current?.parentElement ?? null), []);
  useLayoutEffect(() => {
    if (!host) return;
    const win = host.ownerDocument.defaultView ?? window;
    let raf = 0;
    const measure = () => {
      win.cancelAnimationFrame(raf);
      raf = win.requestAnimationFrame(() => {
        const v = host.querySelector('video');
        const next = containRect(host.clientWidth, host.clientHeight, v?.videoWidth || 0, v?.videoHeight || 0);
        setRect((p) =>
          Math.abs(p.x - next.x) < 0.5 && Math.abs(p.y - next.y) < 0.5 && Math.abs(p.w - next.w) < 0.5 && Math.abs(p.h - next.h) < 0.5
            ? p
            : next
        );
      });
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(host);
    const id = win.setInterval(measure, 1500);
    return () => {
      win.cancelAnimationFrame(raf);
      ro?.disconnect();
      win.clearInterval(id);
    };
  }, [host]);

  if (!ink) return null;
  const show = ink.strokes.length > 0 || (interactive && ink.annotating);
  const drawHere = interactive && ink.annotating;

  const point = (e: React.PointerEvent<HTMLDivElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return toNorm(e.clientX - r.left, e.clientY - r.top, { x: 0, y: 0, w: r.width, h: r.height });
  };

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drawHere || !ink) return;
    if (e.button !== undefined && e.button > 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const [x, y] = point(e);
    const ar = rect.w / Math.max(1, rect.h);
    if (ink.tool === 'eraser') {
      const id = hitAnyPts(ink.strokes, x, y, 0.03, ar);
      if (id) ink.remove(id);
      if (draw) {
        const sid = hitAnyPts(draw.strokes, x, y, 0.03, ar);
        if (sid) {
          draw.setStrokes((s) => s.filter((st) => st.id !== sid));
          void draw.post({ action: 'erase', id: sid });
        }
      }
      return;
    }
    const kind = ink.tool;
    const id = newId();
    const pts = [x, y];
    cur.current = { id, pointer: e.pointerId, kind, x0: x, y0: y, pts };
    ink.upsert({ id, kind, color: ink.color, width: toolWidth(kind, ink.thickness), pts }, false);
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const c = cur.current;
    if (!c || c.pointer !== e.pointerId || !ink) return;
    e.preventDefault();
    const [x, y] = point(e);
    const pts = c.kind === 'pen' || c.kind === 'hl' ? (c.pts.push(x, y), c.pts) : shapePts(c.kind, c.x0, c.y0, x, y);
    if (c.kind !== 'pen' && c.kind !== 'hl') c.pts = pts;
    ink.upsert({ id: c.id, kind: c.kind, color: ink.color, width: toolWidth(c.kind, ink.thickness), pts: pts.slice() }, false);
  };

  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const c = cur.current;
    if (!c || c.pointer !== e.pointerId || !ink) return;
    cur.current = null;
    if (c.pts.length < 2) return;
    ink.upsert(
      { id: c.id, kind: c.kind, color: ink.color, width: toolWidth(c.kind, ink.thickness), pts: c.pts.slice() },
      true
    );
  };

  return (
    <div ref={ref} className="draw-layer" data-teacher-ink style={{ zIndex: 16, pointerEvents: 'none' }}>
      {show && rect.w > 0 && (
        <div className="draw-pic" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
          <svg className="draw-svg" width={rect.w} height={rect.h} viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
            {ink.strokes.map((s) => {
              const opacity = s.kind === 'hl' ? 0.35 : 1;
              const common = {
                fill: 'none',
                stroke: s.color,
                strokeWidth: s.width,
                strokeLinecap: 'round' as const,
                strokeLinejoin: 'round' as const,
                vectorEffect: 'non-scaling-stroke' as const,
                opacity,
              };
              if (s.kind === 'ellipse') {
                const b = ellipseBox(s.pts);
                return <ellipse key={s.id} cx={b.cx} cy={b.cy} rx={Math.max(0.001, b.rx)} ry={Math.max(0.001, b.ry)} {...common} />;
              }
              return (
                <g key={s.id}>
                  <polyline points={pairs(s.pts)} {...common} />
                  {s.kind === 'arrow' && s.pts.length >= 4 ? (
                    <polyline
                      points={pairs(arrowHead(s.pts[s.pts.length - 4]!, s.pts[s.pts.length - 3]!, s.pts[s.pts.length - 2]!, s.pts[s.pts.length - 1]!))}
                      {...common}
                    />
                  ) : null}
                </g>
              );
            })}
          </svg>
          {drawHere && (
            <div
              className="draw-surface"
              style={{ cursor: ink.tool === 'eraser' ? 'cell' : 'crosshair' }}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              role="application"
              aria-label="Draw on the shared screen"
            />
          )}
        </div>
      )}
    </div>
  );
}

'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, type Room } from 'livekit-client';
import { roomFetch } from '@/lib/classroomClient';

/**
 * Screen-share annotation layer.
 *
 * The teacher draws on a transparent surface that is composited over the screen
 * share every participant is already receiving, so students see strokes without
 * any change to the stage. This is deliberately separate from the tldraw
 * whiteboard: annotations must not require the whiteboard stage.
 *
 * Sync model
 * - Strokes stream over the LiveKit data channel (topic `annotate`) for latency,
 *   following the same pattern as Chat.tsx / Whiteboard.tsx.
 * - A debounced Redis snapshot (`/annotate`) backs late joiners and reconnects.
 * - Coordinates are normalised 0..1 against the *video content rect*, so a
 *   4K teacher screen maps correctly onto a letterboxed student viewport
 *   without any resolution negotiation.
 */

const ANNOTATE_TOPIC = 'annotate';
const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

/** Guard against a single packet that would stall the data channel. */
const MAX_PACKET_BYTES = 14_000;

/** Drop the oldest strokes past this so a long share cannot grow unbounded. */
const MAX_STROKES = 400;
/** Points per stroke are simplified beyond this (keeps a scribble cheap). */
const MAX_POINTS_PER_STROKE = 1_200;
/** Debounce before writing the Redis snapshot. */
const PERSIST_DEBOUNCE_MS = 2_000;

export type AnnotateTool = 'pen' | 'highlighter';
/** `eraser` is a pointer mode, not a stroke kind — nothing is recorded for it. */
export type AnnotateMode = AnnotateTool | 'eraser';

export type AnnotatePoint = [number, number];

export type AnnotateStroke = {
  id: string;
  tool: AnnotateTool;
  color: string;
  width: number;
  points: AnnotatePoint[];
};

type AnnotateMsg =
  | { v: 1; type: 'begin'; stroke: AnnotateStroke; from: string }
  | { v: 1; type: 'point'; id: string; p: AnnotatePoint; from: string }
  | { v: 1; type: 'end'; id: string; from: string }
  | { v: 1; type: 'erase'; ids: string[]; from: string }
  | { v: 1; type: 'clear'; from: string };

export const ANNOTATE_COLORS = ['#ef4444', '#22c55e', '#f59e0b', '#3b82f6', '#ffffff'];

const TOOL_WIDTH: Record<AnnotateTool, number> = { pen: 3, highlighter: 18 };

/** SVG user-space is 0..100 on both axes; the element is sized to the video. */
const VB = 100;

function clamp01(n: number) {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function uid() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Where the video content actually lands inside its box, given
 * `object-contain` letterboxing. Falls back to the full box before the video has
 * reported its intrinsic size.
 */
function contentRect(
  frame: HTMLElement,
  videoW: number,
  videoH: number
): { x: number; y: number; w: number; h: number } {
  const w = frame.clientWidth;
  const h = frame.clientHeight;
  if (!w || !h) return { x: 0, y: 0, w: 0, h: 0 };
  if (!videoW || !videoH) return { x: 0, y: 0, w, h };
  const scale = Math.min(w / videoW, h / videoH);
  const dw = videoW * scale;
  const dh = videoH * scale;
  return { x: (w - dw) / 2, y: (h - dh) / 2, w: dw, h: dh };
}

export type ScreenAnnotateApi = {
  strokes: AnnotateStroke[];
  /** Begin a stroke at a normalised point. */
  begin: (p: AnnotatePoint, tool: AnnotateTool, color: string) => void;
  /** Extend the in-progress stroke. */
  extend: (p: AnnotatePoint) => void;
  /** Finish the in-progress stroke and schedule a snapshot write. */
  end: () => void;
  /** Remove strokes near a normalised point (eraser). */
  eraseAt: (p: AnnotatePoint) => void;
  /** Wipe the layer for everyone. */
  clear: () => void;
};

/**
 * Transport + stroke store for the annotation layer.
 *
 * `active` gates the whole thing: nothing is sent, stored or drawn when the
 * share stage is not on screen, so an idle classroom pays nothing.
 */
export function useScreenAnnotate(opts: {
  code: string;
  active: boolean;
  /** Only the teacher may draw. */
  canDraw: boolean;
}): ScreenAnnotateApi {
  const { code, active, canDraw } = opts;
  const room = useRoomContext();
  const [strokes, setStrokes] = useState<AnnotateStroke[]>([]);
  /**
   * Mirror of `strokes` so mutations can be computed *outside* a state updater.
   * React (and StrictMode) may invoke updaters twice, so side effects and
   * bookkeeping must not live inside them.
   */
  const strokesRef = useRef<AnnotateStroke[]>([]);
  const draftRef = useRef<AnnotateStroke | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const identityRef = useRef('anon');

  const commit = useCallback((next: AnnotateStroke[]) => {
    const capped = next.length > MAX_STROKES ? next.slice(next.length - MAX_STROKES) : next;
    strokesRef.current = capped;
    setStrokes(capped);
  }, []);

  useEffect(() => {
    if (room?.localParticipant?.identity) {
      identityRef.current = room.localParticipant.identity;
    }
  }, [room?.localParticipant?.identity]);

  const publish = useCallback(
    async (msg: AnnotateMsg) => {
      if (!room?.localParticipant || !encoder) return;
      try {
        const bytes = encoder.encode(JSON.stringify(msg));
        if (bytes.byteLength > MAX_PACKET_BYTES) return;
        await room.localParticipant.publishData(bytes, {
          reliable: true,
          topic: ANNOTATE_TOPIC,
        });
      } catch (e) {
        console.warn('annotate publish', e);
      }
    },
    [room]
  );

  // Late joiners / reconnects pull the durable snapshot.
  const loadSnapshot = useCallback(async () => {
    try {
      const res = await roomFetch(code, '/annotate');
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data.strokes)) return;
      commit(data.strokes as AnnotateStroke[]);
    } catch {
      /* ignore */
    }
  }, [code, commit]);

  useEffect(() => {
    if (!active) return;
    void loadSnapshot();
  }, [active, loadSnapshot]);

  useEffect(() => {
    if (!active || !room) return;
    const onReconnected = () => {
      void loadSnapshot();
    };
    room.on(RoomEvent.Reconnected, onReconnected);
    return () => {
      room.off(RoomEvent.Reconnected, onReconnected);
    };
  }, [active, room, loadSnapshot]);

  useEffect(() => {
    if (!active || !room) return;
    const onData = (
      payload: Uint8Array,
      _participant?: { identity?: string },
      _kind?: unknown,
      topic?: string
    ) => {
      if (topic && topic !== ANNOTATE_TOPIC) return;
      if (!decoder) return;
      try {
        const msg = JSON.parse(decoder.decode(payload)) as AnnotateMsg;
        if (!msg || msg.v !== 1) return;
        if (msg.from && msg.from === identityRef.current) return;

        if (msg.type === 'begin') {
          const next = strokesRef.current;
          if (next.some((s) => s.id === msg.stroke.id)) return;
          commit([...next, msg.stroke]);
        } else if (msg.type === 'point') {
          commit(
            strokesRef.current.map((s) =>
              s.id !== msg.id || s.points.length >= MAX_POINTS_PER_STROKE
                ? s
                : { ...s, points: [...s.points, msg.p] }
            )
          );
        } else if (msg.type === 'end') {
          // Nothing to do: the draft is already in the list and the final point
          // arrived as a `point`.
        } else if (msg.type === 'erase') {
          const drop = new Set(msg.ids);
          commit(strokesRef.current.filter((s) => !drop.has(s.id)));
        } else if (msg.type === 'clear') {
          commit([]);
        }
      } catch {
        /* ignore malformed */
      }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [active, room]);

  const persist = useCallback(
    (next: AnnotateStroke[]) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void roomFetch(code, '/annotate', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ strokes: next }),
        }).catch(() => undefined);
      }, PERSIST_DEBOUNCE_MS);
    },
    [code]
  );

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const begin = useCallback(
    (p: AnnotatePoint, tool: AnnotateTool, color: string) => {
      if (!active || !canDraw) return;
      const point: AnnotatePoint = [clamp01(p[0]), clamp01(p[1])];
      const stroke: AnnotateStroke = {
        id: uid(),
        tool,
        color,
        width: TOOL_WIDTH[tool],
        points: [point],
      };
      draftRef.current = stroke;
      commit([...strokesRef.current, stroke]);
      void publish({ v: 1, type: 'begin', stroke, from: identityRef.current });
    },
    [active, canDraw, publish, commit]
  );

  const extend = useCallback(
    (p: AnnotatePoint) => {
      const draft = draftRef.current;
      if (!draft || !active || !canDraw) return;
      if (draft.points.length >= MAX_POINTS_PER_STROKE) return;
      const point: AnnotatePoint = [clamp01(p[0]), clamp01(p[1])];
      // Replace with a fresh object so React sees the new point.
      const updated: AnnotateStroke = { ...draft, points: [...draft.points, point] };
      draftRef.current = updated;
      commit(strokesRef.current.map((s) => (s.id === updated.id ? updated : s)));
      void publish({ v: 1, type: 'point', id: updated.id, p: point, from: identityRef.current });
    },
    [active, canDraw, publish, commit]
  );

  const end = useCallback(() => {
    const draft = draftRef.current;
    if (!draft) return;
    draftRef.current = null;
    void publish({ v: 1, type: 'end', id: draft.id, from: identityRef.current });
    persist(strokesRef.current);
  }, [publish, persist]);

  const eraseAt = useCallback(
    (p: AnnotatePoint) => {
      if (!active || !canDraw) return;
      const point: AnnotatePoint = [clamp01(p[0]), clamp01(p[1])];
      // Hit-test in normalised space. A generous radius scaled by stroke width
      // keeps the eraser usable at any pen size.
      const hit: string[] = [];
      const kept = strokesRef.current.filter((s) => {
        const tol = Math.max(0.012, s.width / 900);
        const near = s.points.some(
          (q) => Math.abs(q[0] - point[0]) <= tol && Math.abs(q[1] - point[1]) <= tol
        );
        if (near) hit.push(s.id);
        return !near;
      });
      if (!hit.length) return;
      commit(kept);
      persist(kept);
      void publish({ v: 1, type: 'erase', ids: hit, from: identityRef.current });
    },
    [active, canDraw, publish, persist, commit]
  );

  const clear = useCallback(() => {
    if (!active) return;
    draftRef.current = null;
    commit([]);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    void publish({ v: 1, type: 'clear', from: identityRef.current });
    // Drop the durable copy too, otherwise the next late joiner resurrects it.
    void roomFetch(code, '/annotate', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strokes: [] }),
    }).catch(() => undefined);
  }, [active, code, publish, commit]);

  // Turning the stage off must not leave a stale layer behind for the next share.
  useEffect(() => {
    if (!active) {
      draftRef.current = null;
      commit([]);
      if (saveTimer.current) clearTimeout(saveTimer.current);
    }
  }, [active, commit]);

  return useMemo(
    () => ({ strokes, begin, extend, end, eraseAt, clear }),
    [strokes, begin, extend, end, eraseAt, clear]
  );
}

type Props = {
  /** Element whose box the video is letterboxed inside. */
  frameRef: RefObject<HTMLElement>;
  /** The <video> element, used for its intrinsic aspect. */
  videoRef?: RefObject<HTMLVideoElement | null>;
  strokes: AnnotateStroke[];
  /** Teacher drawing affordances. */
  canDraw?: boolean;
  /** Current pointer mode; pen vs highlighter draw, eraser removes. */
  tool?: AnnotateMode;
  color?: string;
  onBegin?: (p: AnnotatePoint) => void;
  onExtend?: (p: AnnotatePoint) => void;
  onEnd?: () => void;
  onErase?: (p: AnnotatePoint) => void;
  className?: string;
};

/**
 * Transparent SVG overlay sized to the video content rect.
 *
 * Renders strokes for everyone; captures pointer input for the teacher. The
 * SVG is positioned over the letterboxed video and uses a 0..100 user space with
 * `non-scaling-stroke` so pen size stays constant in screen pixels while the
 * geometry stretches to the viewport.
 */
export function ScreenAnnotator({
  frameRef,
  videoRef,
  strokes,
  canDraw = false,
  tool = 'pen',
  color = '#ef4444',
  onBegin,
  onExtend,
  onEnd,
  onErase,
  className,
}: Props) {
  const [rect, setRect] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const drawingRef = useRef(false);

  // Recompute on resize and whenever the video reports its intrinsic size.
  useEffect(() => {
    const frame = frameRef.current;
    const video = videoRef?.current ?? null;
    if (!frame) return;

    const measure = () => {
      const next = contentRect(
        frame,
        video?.videoWidth ?? 0,
        video?.videoHeight ?? 0
      );
      setRect((prev) =>
        prev.x === next.x && prev.y === next.y && prev.w === next.w && prev.h === next.h
          ? prev
          : next
      );
    };

    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(frame);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [frameRef, videoRef]);

  // A late-loading screen share can change aspect after first paint.
  useEffect(() => {
    const video = videoRef?.current;
    if (!video) return;
    const onMeta = () => {
      const frame = frameRef.current;
      if (!frame) return;
      setRect(contentRect(frame, video.videoWidth, video.videoHeight));
    };
    video.addEventListener('loadedmetadata', onMeta);
    return () => video.removeEventListener('loadedmetadata', onMeta);
  }, [frameRef, videoRef]);

  const toLocal = useCallback(
    (e: React.PointerEvent) => {
      const frame = frameRef.current;
      if (!frame) return null as AnnotatePoint | null;
      const box = frame.getBoundingClientRect();
      // rect is relative to the frame's padding box; client coords are viewport.
      const x = e.clientX - box.left - rect.x;
      const y = e.clientY - box.top - rect.y;
      if (!rect.w || !rect.h) return null;
      return [clamp01(x / rect.w), clamp01(y / rect.h)] as AnnotatePoint;
    },
    [frameRef, rect]
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!canDraw) return;
      const p = toLocal(e);
      if (!p) return;
      e.preventDefault();
      e.stopPropagation();
      drawingRef.current = true;
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      if (tool === 'eraser') onErase?.(p);
      else onBegin?.(p);
    },
    [canDraw, toLocal, tool, onErase, onBegin]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!canDraw || !drawingRef.current) return;
      const p = toLocal(e);
      if (!p) return;
      e.preventDefault();
      if (tool === 'eraser') onErase?.(p);
      else onExtend?.(p);
    },
    [canDraw, toLocal, tool, onErase, onExtend]
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!canDraw || !drawingRef.current) return;
      drawingRef.current = false;
      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
      if (tool !== 'eraser') onEnd?.();
    },
    [canDraw, tool, onEnd]
  );

  if (!rect.w || !rect.h) return null;

  return (
    <div
      className={className}
      style={{
        position: 'absolute',
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        // Above the video element it overlays; below nothing.
        zIndex: 2,
        // Read-only overlays must not swallow taps meant for the controls
        // beneath them.
        pointerEvents: canDraw ? 'auto' : 'none',
      }}
    >
      <svg
        className="h-full w-full"
        viewBox={`0 0 ${VB} ${VB}`}
        preserveAspectRatio="none"
        style={{ touchAction: 'none', overflow: 'visible' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {strokes.map((s) => {
          if (s.points.length === 0) return null;
          const d = s.points
            .map((p, i) => `${i === 0 ? 'M' : 'L'}${(p[0] * VB).toFixed(2)} ${(p[1] * VB).toFixed(2)}`)
            .join(' ');
          return (
            <path
              key={s.id}
              d={d}
              fill="none"
              stroke={s.color}
              strokeWidth={s.width}
              strokeLinecap="round"
              strokeLinejoin="round"
              // Constant screen-pixel pen size regardless of the 0..100 space.
              vectorEffect="non-scaling-stroke"
              opacity={s.tool === 'highlighter' ? 0.35 : 1}
            />
          );
        })}
      </svg>
    </div>
  );
}

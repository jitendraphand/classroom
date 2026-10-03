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
import { RoomEvent } from 'livekit-client';
import { roomFetch } from '@/lib/classroomClient';
import { fitSnapshot, mergeSnapshot, quantize, strokeHit } from '@/lib/annotateGeometry';

/**
 * Screen-share annotation layer.
 *
 * The teacher draws on a transparent surface that is composited over the screen
 * share every participant is already receiving, so students see strokes without
 * any change to the stage. Annotations exist only while the screen stage is on.
 *
 * Sync model
 * - Strokes stream over the LiveKit data channel (topic `annotate`) for latency,
 *   following the same pattern as Chat.tsx.
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
/** Debounce before writing the Redis snapshot. Short enough that a late joiner is not a stroke behind. */
const PERSIST_DEBOUNCE_MS = 400;
/** Coalesce pointer moves so a scribble is not one data packet per event. */
const POINT_FLUSH_MS = 40;
const POINT_FLUSH_COUNT = 6;

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
  | { v: 1; type: 'points'; id: string; pts: AnnotatePoint[]; from: string }
  | { v: 1; type: 'end'; id: string; from: string }
  | { v: 1; type: 'erase'; ids: string[]; from: string }
  | { v: 1; type: 'clear'; from: string }
  | { v: 1; type: 'undo'; id: string; from: string }
  | { v: 1; type: 'snapshot'; strokes: AnnotateStroke[]; from: string };

export const ANNOTATE_COLORS = ['#ef4444', '#22c55e', '#f59e0b', '#3b82f6', '#ffffff'];

const TOOL_WIDTH: Record<AnnotateTool, number> = { pen: 3, highlighter: 18 };

/** SVG user-space is 0..100 on both axes; the element is sized to the video. */
const VB = 100;

/**
 * True when a data packet came from a teacher. LiveKit sets `participant` from
 * the sender's token (identity and metadata are chosen by our server, not the
 * browser): teacher identities are `teacher_…` and carry role TEACHER.
 */
export function isTeacherSender(participant?: { identity?: string; metadata?: string }): boolean {
  const identity = participant?.identity;
  if (!identity || !identity.startsWith('teacher_')) return false;
  if (!participant?.metadata) return true;
  try {
    const meta = JSON.parse(participant.metadata) as { role?: string };
    return meta.role === undefined || meta.role === 'TEACHER';
  } catch {
    return true;
  }
}

function clamp01(n: number) {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function uid() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Where the video pixels land inside the frame, given `object-contain`.
 * Uses the real <video> box (LiveKit renders it inside the frame) so teacher
 * and student letterboxing agree. Returns an empty rect until intrinsic size
 * is known — mapping onto the whole tile is what made strokes miss.
 */
function measureContent(
  frame: HTMLElement,
  video: HTMLVideoElement | null
): { x: number; y: number; w: number; h: number } {
  const frameBox = frame.getBoundingClientRect();
  if (!frameBox.width || !frameBox.height || !video) return { x: 0, y: 0, w: 0, h: 0 };
  const videoBox = video.getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh || !videoBox.width || !videoBox.height) return { x: 0, y: 0, w: 0, h: 0 };
  const scale = Math.min(videoBox.width / vw, videoBox.height / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  return {
    x: videoBox.left - frameBox.left + (videoBox.width - dw) / 2,
    y: videoBox.top - frameBox.top + (videoBox.height - dh) / 2,
    w: dw,
    h: dh,
  };
}

/**
 * Durable copy for late joiners. Trimmed to the server's size cap first: an
 * oversized body used to be rejected (413) silently, so after a few scribbles
 * nobody who joined late or reconnected saw any annotations.
 */
function putSnapshot(code: string, strokes: AnnotateStroke[]) {
  return roomFetch(code, '/annotate', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ strokes: fitSnapshot(strokes) }),
  }).catch(() => undefined);
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
  /** Remove the teacher's most recent stroke for everyone. */
  undo: () => void;
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
  const pointBuf = useRef<{ id: string; pts: AnnotatePoint[] } | null>(null);
  const pointTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedRef = useRef(false);
  /** Ids of strokes this client drew, newest last (for undo). */
  const ownIds = useRef<string[]>([]);
  /** Ids erased/undone/cleared this session, so a slow snapshot read cannot resurrect them. */
  const erasedRef = useRef<Set<string>>(new Set());

  const commit = useCallback((next: AnnotateStroke[]) => {
    const capped = next.length > MAX_STROKES ? next.slice(next.length - MAX_STROKES) : next;
    strokesRef.current = capped;
    setStrokes(capped);
  }, []);

  const sender = useCallback(() => {
    const id = room?.localParticipant?.identity;
    if (id) identityRef.current = id;
    return identityRef.current || 'anon';
  }, [room]);

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
      const raw = data?.strokes;
      const list = Array.isArray(raw)
        ? raw
        : raw && typeof raw === 'object' && Array.isArray(raw.strokes)
          ? raw.strokes
          : null;
      if (!list) return;
      // Merge rather than replace: live packets that arrived while this read
      // was in flight are kept, and so is everything drawn before we joined.
      commit(mergeSnapshot(list as AnnotateStroke[], strokesRef.current, erasedRef.current));
    } catch {
      /* ignore */
    } finally {
      loadedRef.current = true;
    }
  }, [code, commit]);

  useEffect(() => {
    if (!active) return;
    void loadSnapshot();
    // The teacher re-saves the snapshot when we connect; read it once more so a
    // join that raced the first read still catches up (merge makes it idempotent).
    const t = window.setTimeout(() => void loadSnapshot(), 2500);
    return () => window.clearTimeout(t);
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
      participant?: { identity?: string; metadata?: string },
      _kind?: unknown,
      topic?: string
    ) => {
      if (topic !== ANNOTATE_TOPIC) return;
      if (!decoder) return;
      // Trust the sender identity LiveKit authenticated (from the server-minted
      // token), never the self-declared `from` field. Only a teacher may draw,
      // erase, clear or replace the layer.
      if (!isTeacherSender(participant)) return;
      try {
        const msg = JSON.parse(decoder.decode(payload)) as AnnotateMsg;
        if (!msg || msg.v !== 1) return;

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
        } else if (msg.type === 'points') {
          const incoming = Array.isArray(msg.pts) ? msg.pts : [];
          commit(
            strokesRef.current.map((s) => {
              if (s.id !== msg.id || incoming.length === 0) return s;
              const roomLeft = MAX_POINTS_PER_STROKE - s.points.length;
              if (roomLeft <= 0) return s;
              return { ...s, points: [...s.points, ...incoming.slice(0, roomLeft)] };
            })
          );
        } else if (msg.type === 'snapshot') {
          if (Array.isArray(msg.strokes)) commit(msg.strokes.slice(-MAX_STROKES));
        } else if (msg.type === 'end') {
          // Nothing to do: the draft is already in the list and the final points
          // arrived ahead of this message.
        } else if (msg.type === 'erase') {
          const drop = new Set(msg.ids);
          for (const id of drop) erasedRef.current.add(id);
          commit(strokesRef.current.filter((s) => !drop.has(s.id)));
        } else if (msg.type === 'undo') {
          erasedRef.current.add(msg.id);
          commit(strokesRef.current.filter((s) => s.id !== msg.id));
        } else if (msg.type === 'clear') {
          for (const st of strokesRef.current) erasedRef.current.add(st.id);
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
  }, [active, room, commit]);

  const writeSnapshot = useCallback(
    (next: AnnotateStroke[]) => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      void putSnapshot(code, next);
    },
    [code]
  );

  const persist = useCallback(
    (next: AnnotateStroke[]) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        void putSnapshot(code, next);
      }, PERSIST_DEBOUNCE_MS);
    },
    [code]
  );

  const flushPoints = useCallback(() => {
    if (pointTimer.current) {
      clearTimeout(pointTimer.current);
      pointTimer.current = null;
    }
    const buf = pointBuf.current;
    pointBuf.current = null;
    if (!buf || buf.pts.length === 0) return Promise.resolve();
    return publish({ v: 1, type: 'points', id: buf.id, pts: buf.pts, from: sender() });
  }, [publish, sender]);

  const discardPoints = useCallback(() => {
    if (pointTimer.current) {
      clearTimeout(pointTimer.current);
      pointTimer.current = null;
    }
    pointBuf.current = null;
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (pointTimer.current) clearTimeout(pointTimer.current);
      pointBuf.current = null;
    };
  }, []);

  const begin = useCallback(
    (p: AnnotatePoint, tool: AnnotateTool, color: string) => {
      if (!active || !canDraw) return;
      flushPoints();
      const point: AnnotatePoint = quantize(p);
      const stroke: AnnotateStroke = {
        id: uid(),
        tool,
        color,
        width: TOOL_WIDTH[tool],
        points: [point],
      };
      draftRef.current = stroke;
      ownIds.current.push(stroke.id);
      commit([...strokesRef.current, stroke]);
      void publish({ v: 1, type: 'begin', stroke, from: sender() });
    },
    [active, canDraw, publish, commit, flushPoints, sender]
  );

  const extend = useCallback(
    (p: AnnotatePoint) => {
      const draft = draftRef.current;
      if (!draft || !active || !canDraw) return;
      if (draft.points.length >= MAX_POINTS_PER_STROKE) return;
      const point: AnnotatePoint = quantize(p);
      const last = draft.points[draft.points.length - 1];
      // Identical consecutive points only bloat packets and the snapshot.
      if (last && last[0] === point[0] && last[1] === point[1]) return;
      // Replace with a fresh object so React sees the new point.
      const updated: AnnotateStroke = { ...draft, points: [...draft.points, point] };
      draftRef.current = updated;
      commit(strokesRef.current.map((s) => (s.id === updated.id ? updated : s)));
      const buf = pointBuf.current;
      if (!buf || buf.id !== updated.id) {
        flushPoints();
        pointBuf.current = { id: updated.id, pts: [point] };
      } else {
        buf.pts.push(point);
      }
      const pending = pointBuf.current;
      if (pending && pending.pts.length >= POINT_FLUSH_COUNT) {
        flushPoints();
      } else if (!pointTimer.current) {
        pointTimer.current = setTimeout(() => {
          pointTimer.current = null;
          flushPoints();
        }, POINT_FLUSH_MS);
      }
    },
    [active, canDraw, commit, flushPoints]
  );

  const end = useCallback(() => {
    const draft = draftRef.current;
    if (!draft) return;
    draftRef.current = null;
    const id = draft.id;
    void (async () => {
      await flushPoints();
      await publish({ v: 1, type: 'end', id, from: sender() });
      persist(strokesRef.current);
    })();
  }, [publish, persist, flushPoints, sender]);

  const eraseAt = useCallback(
    (p: AnnotatePoint) => {
      if (!active || !canDraw) return;
      const point: AnnotatePoint = [clamp01(p[0]), clamp01(p[1])];
      // Hit-test every segment (not just the vertices) in normalised space. A
      // generous radius scaled by stroke width keeps the eraser usable at any size.
      const hit: string[] = [];
      const kept = strokesRef.current.filter((s) => {
        const near = s.id !== draftRef.current?.id && strokeHit(s, point);
        if (near) hit.push(s.id);
        return !near;
      });
      if (!hit.length) return;
      for (const id of hit) erasedRef.current.add(id);
      commit(kept);
      persist(kept);
      void publish({ v: 1, type: 'erase', ids: hit, from: sender() });
    },
    [active, canDraw, publish, persist, commit, sender]
  );

  const clear = useCallback(() => {
    if (!active) return;
    draftRef.current = null;
    discardPoints();
    for (const st of strokesRef.current) erasedRef.current.add(st.id);
    ownIds.current = [];
    commit([]);
    void publish({ v: 1, type: 'clear', from: sender() });
    // Drop the durable copy too, otherwise the next late joiner resurrects it.
    writeSnapshot([]);
  }, [active, publish, commit, discardPoints, sender, writeSnapshot]);

  const undo = useCallback(() => {
    if (!active || !canDraw) return;
    // Pop own strokes that still exist (one may already have been erased).
    let id: string | undefined;
    while ((id = ownIds.current.pop())) {
      const target = id;
      if (strokesRef.current.some((s) => s.id === target)) break;
    }
    if (!id) return;
    if (draftRef.current?.id === id) {
      draftRef.current = null;
      discardPoints();
    }
    const target = id;
    erasedRef.current.add(target);
    const kept = strokesRef.current.filter((s) => s.id !== target);
    commit(kept);
    persist(kept);
    void publish({ v: 1, type: 'undo', id: target, from: sender() });
  }, [active, canDraw, commit, persist, publish, sender, discardPoints]);

  // A student who joins mid-share never saw the live packets. Push the current
  // layer immediately; fall back to Redis when it will not fit in one packet.
  useEffect(() => {
    if (!active || !room || !canDraw) return;
    const send = () => {
      if (!loadedRef.current) return;
      const from = sender();
      void (async () => {
        // Pending points are already in the stroke list. Ship them first so a
        // snapshot that follows cannot be applied and then doubled.
        await flushPoints();
        const strokes = strokesRef.current;
        const msg: AnnotateMsg = { v: 1, type: 'snapshot', strokes, from };
        let bytes = MAX_PACKET_BYTES + 1;
        try {
          bytes = encoder ? encoder.encode(JSON.stringify(msg)).byteLength : bytes;
        } catch {
          bytes = MAX_PACKET_BYTES + 1;
        }
        // The newcomer's data listener may not be attached yet (it starts when
        // its stage poll sees the share), so always refresh the durable copy
        // too; the packet is just the fast path.
        if (bytes <= MAX_PACKET_BYTES) await publish(msg);
        writeSnapshot(strokes);
      })();
    };
    room.on(RoomEvent.ParticipantConnected, send);
    return () => {
      room.off(RoomEvent.ParticipantConnected, send);
    };
  }, [active, room, canDraw, publish, sender, writeSnapshot, flushPoints]);

  // Turning the stage off must not leave a stale layer behind for the next share.
  useEffect(() => {
    if (!active) {
      draftRef.current = null;
      discardPoints();
      loadedRef.current = false;
      ownIds.current = [];
      erasedRef.current = new Set();
      commit([]);
      if (saveTimer.current) clearTimeout(saveTimer.current);
    }
  }, [active, commit, discardPoints]);

  return useMemo(
    () => ({ strokes, begin, extend, end, eraseAt, clear, undo }),
    [strokes, begin, extend, end, eraseAt, clear, undo]
  );
}

type Props = {
  /** Element whose box the video is letterboxed inside. */
  frameRef: RefObject<HTMLElement | null>;
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
  /** The one pointer currently drawing; a second finger or a palm is ignored. */
  const drawingRef = useRef<number | null>(null);

  // The <video> is attached by LiveKit after this layer mounts. Watch the frame
  // until the element exists and reports videoWidth, then track its box.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let video: HTMLVideoElement | null = null;
    let stopped = false;
    let interval = 0;
    let metaCleanup: (() => void) | null = null;

    const measure = () => {
      if (stopped) return;
      const next = measureContent(frame, video);
      setRect((prev) =>
        prev.x === next.x && prev.y === next.y && prev.w === next.w && prev.h === next.h ? prev : next
      );
    };
    const videoRo = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => measure()) : null;

    const bindVideo = (next: HTMLVideoElement | null) => {
      if (next === video) return;
      metaCleanup?.();
      metaCleanup = null;
      if (video) videoRo?.unobserve(video);
      video = next;
      if (!video) return;
      const onMeta = () => measure();
      video.addEventListener('loadedmetadata', onMeta);
      video.addEventListener('resize', onMeta);
      video.addEventListener('loadeddata', onMeta);
      videoRo?.observe(video);
      metaCleanup = () => {
        video?.removeEventListener('loadedmetadata', onMeta);
        video?.removeEventListener('resize', onMeta);
        video?.removeEventListener('loadeddata', onMeta);
      };
      measure();
    };

    const scan = () => {
      const found = videoRef?.current ?? frame.querySelector('video');
      bindVideo(found);
      if (found && found.videoWidth > 0 && interval) {
        window.clearInterval(interval);
        interval = 0;
      }
    };

    scan();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
      scan();
      measure();
    }) : null;
    ro?.observe(frame);
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(scan) : null;
    mo?.observe(frame, { childList: true, subtree: true });
    const started = Date.now();
    interval = window.setInterval(() => {
      scan();
      if ((video && video.videoWidth > 0) || Date.now() - started > 8000) {
        window.clearInterval(interval);
        interval = 0;
      }
    }, 500);
    window.addEventListener('resize', measure);
    return () => {
      stopped = true;
      ro?.disconnect();
      videoRo?.disconnect();
      mo?.disconnect();
      metaCleanup?.();
      if (interval) window.clearInterval(interval);
      window.removeEventListener('resize', measure);
    };
  }, [frameRef, videoRef]);

  const toLocal = useCallback(
    (e: { clientX: number; clientY: number }) => {
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
      // Only the primary button draws (right-click opened a stroke before), and
      // only one pointer at a time: a second touch used to replace the draft so
      // the first finger's moves were appended to the wrong stroke.
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (drawingRef.current !== null) return;
      const p = toLocal(e);
      if (!p) return;
      e.preventDefault();
      e.stopPropagation();
      drawingRef.current = e.pointerId;
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      if (tool === 'eraser') onErase?.(p);
      else onBegin?.(p);
    },
    [canDraw, toLocal, tool, onErase, onBegin]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!canDraw || drawingRef.current !== e.pointerId) return;
      e.preventDefault();
      // Coalesced events keep fast strokes smooth (one move event can carry several samples).
      const native = e.nativeEvent as PointerEvent;
      const samples: Array<{ clientX: number; clientY: number }> =
        typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
      const list = samples.length ? samples : [e];
      for (const ev of list) {
        const p = toLocal(ev);
        if (!p) continue;
        if (tool === 'eraser') onErase?.(p);
        else onExtend?.(p);
      }
    },
    [canDraw, toLocal, tool, onErase, onExtend]
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (drawingRef.current !== e.pointerId) return;
      drawingRef.current = null;
      try {
        (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
      } catch {
        /* already released */
      }
      if (tool !== 'eraser') onEnd?.();
    },
    [tool, onEnd]
  );

  // Turning drawing off mid-stroke (or a tool switch) must still finish the stroke.
  const endRef = useRef(onEnd);
  endRef.current = onEnd;
  useEffect(() => {
    if (canDraw) return;
    if (drawingRef.current !== null) {
      drawingRef.current = null;
      endRef.current?.();
    }
  }, [canDraw]);

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
        zIndex: 5,
        touchAction: 'none',
        cursor: canDraw ? 'crosshair' : 'default',
        // Read-only overlays must not swallow taps meant for the controls
        // beneath them.
        pointerEvents: canDraw ? 'auto' : 'none',
      }}
    >
      <svg
        className="h-full w-full"
        viewBox={`0 0 ${VB} ${VB}`}
        preserveAspectRatio="none"
        style={{ touchAction: 'none', overflow: 'visible', cursor: canDraw ? 'crosshair' : 'default' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        // Capture can be lost without a pointerup (window blur, PiP focus, OS
        // gesture); treat it as the end of the stroke instead of drawing forever.
        onLostPointerCapture={onPointerUp}
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

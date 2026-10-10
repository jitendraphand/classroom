'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RoomEvent, type Room } from 'livekit-client';
import { roomFetch, getClassroomRole } from '@/lib/classroomClient';
import { STATE_TOPIC, statePollMs } from '@/lib/pollPolicy';
import { usePageHidden, usePushLive } from '@/hooks/usePollSignals';

/** Teacher-only roster details (school-app students). */
export type RosterInfo = {
  rollNumber?: string | null;
  gradeDivision?: string | null;
  /** School student ID (teacher view only). */
  sid?: string | null;
  late?: boolean;
  onTimetable?: boolean;
  /** The running class is ad hoc (not from the timetable): no timetable wording. */
  adHocClass?: boolean;
  viaSchoolApp?: boolean;
};

export type RoomState = {
  code: string;
  name: string;
  status: string;
  ended?: boolean;
  public?: boolean;
  maxVisibleVideos: number;
  /** Waiting room for this class session (teacher toggle; default on). */
  waitingRoomOn?: boolean;
  isTeacher: boolean;
  teacherName: string;
  actingAsStudent?: boolean;
  me: {
    id: string;
    displayName: string;
    role: string;
    status: string;
    /** Signed in through the school app (has a /student home). */
    viaSchoolApp?: boolean;
    livekitIdentity: string;
    mutedByTeacher: boolean;
    canPublishVideo: boolean;
    inVisibleSample: boolean;
    /** Camera video wanted now (sample AND teacher panel shown). Missing on old servers. */
    camWanted?: boolean;
    handRaised?: boolean;
    /** Asked to draw on the share (waiting for the teacher). */
    drawRequested?: boolean;
    /** Allowed to draw on the share now. */
    canDraw?: boolean;
  } | null;
  waiting?: ({ id: string; displayName: string } & RosterInfo)[];
  admitted: ({
    focus?: import('@/lib/focusStatus').FocusStatus;
    focusIphone?: boolean;
    id: string;
    displayName: string;
    role: string;
    livekitIdentity: string;
    mutedByTeacher: boolean;
    isVisible: boolean;
    handRaised?: boolean;
    /** Teacher only: ms epoch the hand went up. */
    handRaisedAt?: number | null;
    /** Teacher only: teacher pinned this student's video. */
    pinned?: boolean;
    pinnedAt?: number | null;
    /** Teacher only: asked to draw on the share, and when. */
    drawRequested?: boolean;
    drawRequestedAt?: number | null;
    /** Allowed to draw now. */
    drawing?: boolean;
  } & RosterInfo)[];
  /** Teacher only: the class session running in this room. */
  classSession?: { subject: string; audience: string; adHoc: boolean } | null;
  visibleIdentities: string[];
  visibleCount: number;
  raisedHands?: string[];
  stageMode?: 'idle' | 'screen';
  /** Student ink is drawn on the teacher's real desktop (inside the share picture). */
  desktopInk?: boolean;
  /** Teacher's student-video panel shown (cameras on demand). */
  videoPanelOpen?: boolean;
  drawHolder?: import('@/lib/drawLogic').DrawHolder | null;
  drawRequestCount?: number;
};

/** `{v:1,type:'mute',muted}` from the server → muted flag; anything else → null. */
export function decodeMutePush(decoder: TextDecoder | null, payload: Uint8Array): boolean | null {
  if (!decoder) return null;
  try {
    const msg = JSON.parse(decoder.decode(payload)) as { v?: number; type?: string; muted?: unknown };
    if (msg && msg.v === 1 && msg.type === 'mute' && typeof msg.muted === 'boolean') return msg.muted;
  } catch {
    /* not JSON */
  }
  return null;
}

export function useRoomState(code: string, intervalMs = 2000, room?: Room | null) {
  const [state, setState] = useState<RoomState | null>(null);
  const [error, setError] = useState('');
  const stopped = useRef(false);
  /** One poll at a time. A mutation during that poll schedules a follow-up so an older snapshot cannot overwrite it. */
  const inflight = useRef(false);
  const again = useRef(false);
  const lastFetchAt = useRef(0);
  const mutePush = useRef<{ muted: boolean; at: number } | null>(null);

  const refresh = useCallback(async () => {
    if (stopped.current) return;
    if (inflight.current) {
      again.current = true;
      return;
    }
    inflight.current = true;
    const startedAt = Date.now();
    lastFetchAt.current = startedAt;
    try {
      const res = await roomFetch(code, '/state');
      const data = await res.json();
      if (stopped.current) return;
      if (!res.ok) {
        if (res.status === 410 || data.ended || data.status === 'ENDED') {
          setState((prev) =>
            prev
              ? { ...prev, status: 'ENDED', ended: true }
              : {
                  code,
                  name: data.name || 'Classroom',
                  status: 'ENDED',
                  ended: true,
                  maxVisibleVideos: 0,
                  isTeacher: false,
                  teacherName: '',
                  me: null,
                  admitted: [],
                  visibleIdentities: [],
                  visibleCount: 0,
                }
          );
          stopped.current = true;
          setError('');
          return;
        }
        setError(data.error || 'Failed to load room');
        return;
      }
      if (data.status === 'ENDED' || data.ended) {
        setState({ ...data, status: 'ENDED', ended: true });
        stopped.current = true;
        setError('');
        return;
      }
      // A snapshot requested before a mute push must not undo it.
      const push = mutePush.current;
      if (push && startedAt < push.at && data.me) data.me.mutedByTeacher = push.muted;
      setState(data);
      setError('');
    } catch {
      if (!stopped.current) setError('Network error');
    } finally {
      inflight.current = false;
      if (again.current && !stopped.current) {
        again.current = false;
        void refresh();
      }
    }
  }, [code]);

  const hidden = usePageHidden();
  const pushLive = usePushLive(room);

  useEffect(() => {
    stopped.current = false;
    refresh();
  }, [refresh]);

  // Safety-net poll. Fast (intervalMs, students ≤ 2 s) until LiveKit is
  // connected; slower once server "state changed" pushes can arrive.
  useEffect(() => {
    const role = typeof window !== 'undefined' ? getClassroomRole(code) : null;
    const base = statePollMs({ role, hidden, pushLive });
    const ms = pushLive || hidden ? base : role === 'student' ? Math.min(intervalMs, 2000) : intervalMs;
    // Tick at a third of the period and skip when a push-driven refresh ran
    // recently, so pushes push the safety poll back instead of adding to it.
    const t = setInterval(() => {
      if (stopped.current) return;
      if (Date.now() - lastFetchAt.current < ms - 250) return;
      void refresh();
    }, Math.max(500, Math.round(ms / 3)));
    return () => clearInterval(t);
  }, [refresh, intervalMs, code, hidden, pushLive]);

  // Coming back to the tab: refresh immediately rather than at the next tick.
  useEffect(() => {
    if (!hidden && !stopped.current) void refresh();
  }, [hidden, refresh]);

  // Server push: refetch now (coalesced by the inflight/again guard above).
  useEffect(() => {
    if (!room) return;
    const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
    const onData = (payload: Uint8Array, participant?: unknown, _k?: unknown, topic?: string) => {
      // Only the server sends this topic; a packet from a participant is ignored.
      if (topic !== STATE_TOPIC || participant) return;
      const muted = decodeMutePush(decoder, payload);
      // Teacher (un)muted me: flip the mic button now; the refetch confirms it.
      if (muted !== null) {
        mutePush.current = { muted, at: Date.now() };
        setState((prev) => (prev?.me ? { ...prev, me: { ...prev.me, mutedByTeacher: muted } } : prev));
      }
      if (!stopped.current) void refresh();
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room, refresh]);

  return { state, error, refresh, stopped: stopped.current };
}

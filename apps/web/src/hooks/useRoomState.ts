'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { roomFetch, getClassroomRole } from '@/lib/classroomClient';

/** Teacher-only roster details (school-app students). */
export type RosterInfo = {
  rollNumber?: string | null;
  gradeDivision?: string | null;
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
    handRaised?: boolean;
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
  } & RosterInfo)[];
  /** Teacher only: the class session running in this room. */
  classSession?: { subject: string; audience: string; adHoc: boolean } | null;
  visibleIdentities: string[];
  visibleCount: number;
  raisedHands?: string[];
  stageMode?: 'idle' | 'screen';
};

export function useRoomState(code: string, intervalMs = 2000) {
  const [state, setState] = useState<RoomState | null>(null);
  const [error, setError] = useState('');
  const stopped = useRef(false);
  /** One poll at a time. A mutation during that poll schedules a follow-up so an older snapshot cannot overwrite it. */
  const inflight = useRef(false);
  const again = useRef(false);

  const refresh = useCallback(async () => {
    if (stopped.current) return;
    if (inflight.current) {
      again.current = true;
      return;
    }
    inflight.current = true;
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

  useEffect(() => {
    stopped.current = false;
    refresh();
    // Students poll mute/end faster; teachers same default
    const role = typeof window !== 'undefined' ? getClassroomRole(code) : null;
    const ms = role === 'student' ? Math.min(intervalMs, 2000) : intervalMs;
    const t = setInterval(() => {
      if (stopped.current) return;
      void refresh();
    }, ms);
    return () => clearInterval(t);
  }, [refresh, intervalMs, code]);

  return { state, error, refresh, stopped: stopped.current };
}

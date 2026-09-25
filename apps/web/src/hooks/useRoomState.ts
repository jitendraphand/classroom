'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { roomFetch, getClassroomRole } from '@/lib/classroomClient';

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
    livekitIdentity: string;
    mutedByTeacher: boolean;
    canPublishVideo: boolean;
    inVisibleSample: boolean;
  } | null;
  waiting?: { id: string; displayName: string }[];
  admitted: {
    id: string;
    displayName: string;
    role: string;
    livekitIdentity: string;
    mutedByTeacher: boolean;
    isVisible: boolean;
  }[];
  visibleIdentities: string[];
  visibleCount: number;
  stageMode?: 'idle' | 'screen' | 'whiteboard';
  whiteboardCanWrite?: boolean;
  /** Raw Redis flag: students may draw when true. */
  whiteboardWriteAllowed?: boolean;
};

export function useRoomState(code: string, intervalMs = 2000) {
  const [state, setState] = useState<RoomState | null>(null);
  const [error, setError] = useState('');
  const stopped = useRef(false);

  const refresh = useCallback(async () => {
    if (stopped.current) return;
    try {
      const res = await roomFetch(code, '/state');
      const data = await res.json();
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
      setError('Network error');
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

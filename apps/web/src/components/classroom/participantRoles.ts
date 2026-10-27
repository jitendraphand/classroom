'use client';

/**
 * Who is the teacher in the LiveKit room (identity / metadata), and live
 * teacher presence and screen-share hooks. Shared by the classroom views.
 * (Split out of ClassroomRoom.tsx.)
 */
import { useTracks, useRoomContext } from '@livekit/components-react';
import { Track, RoomEvent, ConnectionState } from 'livekit-client';
import { useEffect, useMemo, useState } from 'react';
import { TEACHER_ABSENCE_GRACE_MS } from '@/lib/graceTimer';

export function isTeacherParticipant(
  p: { metadata?: string; identity: string; name?: string },
  teacherIdentities: Set<string>
) {
  if (teacherIdentities.has(p.identity)) return true;
  if (p.identity.startsWith('teacher_')) return true;
  if (p.identity.startsWith('student_')) return false;
  try {
    const meta = p.metadata ? JSON.parse(p.metadata) : {};
    if (meta.role === 'TEACHER') return true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Live teacher presence from the LiveKit room (not the DB roster): true while a
 * teacher participant is connected, false when none is, null until this
 * client's own connection is up (so a join does not flash "absent").
 * While this client is itself reconnecting, the last answer is kept.
 */
export function useTeacherLive(teacherIdentities: string[]): boolean | null {
  const room = useRoomContext();
  const key = teacherIdentities.join(',');
  const [live, setLive] = useState<boolean | null>(null);
  useEffect(() => {
    if (!room) return;
    const set = new Set(key ? key.split(',') : []);
    // Grace period: a teacher who was here and drops (device switch, reload,
    // blip) still counts as present for TEACHER_ABSENCE_GRACE_MS, matching the
    // server, so students see no "teacher left" flicker or mic lock.
    let shown: boolean | null = null;
    let grace: number | null = null;
    const show = (v: boolean | null) => {
      shown = v;
      setLive(v);
    };
    const clearGrace = () => {
      if (grace !== null) window.clearTimeout(grace);
      grace = null;
    };
    const teacherHere = () =>
      Array.from(room.remoteParticipants.values()).some((p) => isTeacherParticipant(p, set));
    const update = () => {
      if (room.state !== ConnectionState.Connected) {
        if (room.state === ConnectionState.Disconnected) {
          clearGrace();
          show(null);
        }
        return;
      }
      if (teacherHere()) {
        clearGrace();
        show(true);
        return;
      }
      if (shown !== true) {
        show(false);
        return;
      }
      if (grace === null) {
        grace = window.setTimeout(() => {
          grace = null;
          if (room.state === ConnectionState.Connected && !teacherHere()) show(false);
        }, TEACHER_ABSENCE_GRACE_MS);
      }
    };
    update();
    room.on(RoomEvent.ParticipantConnected, update);
    room.on(RoomEvent.ParticipantDisconnected, update);
    room.on(RoomEvent.ConnectionStateChanged, update);
    room.on(RoomEvent.Reconnected, update);
    return () => {
      room.off(RoomEvent.ParticipantConnected, update);
      room.off(RoomEvent.ParticipantDisconnected, update);
      room.off(RoomEvent.ConnectionStateChanged, update);
      room.off(RoomEvent.Reconnected, update);
      clearGrace();
    };
  }, [room, key]);
  return live;
}

export function useHasTeacherScreen(teacherIdentities: string[]) {
  const tracks = useTracks(
    [{ source: Track.Source.ScreenShare, withPlaceholder: false }],
    { onlySubscribed: true }
  );
  const teacherSet = useMemo(() => new Set(teacherIdentities), [teacherIdentities]);
  return tracks.some((t) => {
    if (t.source !== Track.Source.ScreenShare) return false;
    if (t.participant.isLocal) return false;
    return isTeacherParticipant(t.participant, teacherSet);
  });
}

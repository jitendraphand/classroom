'use client';

/**
 * Student-side media privacy: a student subscribes only to the teacher,
 * classmates' microphones and the spotlighted camera, and lets only the
 * teacher (plus classmates, for the mic / spotlight camera) subscribe to their
 * own tracks. (Split out of ClassroomRoom.tsx.)
 */
import { useRoomContext } from '@livekit/components-react';
import { Track, RoomEvent, ConnectionState, VideoQuality, type ParticipantTrackPermission } from 'livekit-client';
import { useEffect, useRef } from 'react';
import { isTeacherParticipant } from './participantRoles';

/**
 * Student-side media privacy (H-4).
 *
 * Subscriber side: the student connects with autoSubscribe off and subscribes
 * only to the teacher's tracks (camera, microphone, screen) and to classmates'
 * microphones (class audio is not limited by the sample). Other students'
 * cameras stay unsubscribed, except the one teacher-spotlighted student.
 *
 * Publisher side (enforced by the SFU for this student's own tracks): only
 * the teacher may subscribe to everything; classmates may subscribe to the
 * microphone track only, plus this camera while this student is spotlighted.
 */
export function StudentMediaPrivacy({
  teacherIdentities,
  studentIdentities,
  spotlightIdentity = null,
}: {
  teacherIdentities: string[];
  studentIdentities: string[];
  /** LiveKit identity of the spotlighted student, if any. */
  spotlightIdentity?: string | null;
}) {
  const room = useRoomContext();
  const teacherKey = teacherIdentities.join(',');
  const studentKey = studentIdentities.join(',');
  const lastPermKey = useRef('');

  useEffect(() => {
    if (!room) return;
    const teacherSet = new Set(teacherKey ? teacherKey.split(',') : []);
    const rosterStudents = studentKey ? studentKey.split(',') : [];

    const sync = () => {
      if (room.state !== ConnectionState.Connected) return;
      const teachers = new Set<string>(teacherSet);
      const classmates = new Set<string>(rosterStudents);

      // Bandwidth: while the teacher shares, their camera is a corner tile,
      // so take its small simulcast layer only (≈90 kbps instead of ≈300).
      const sharing = Array.from(room.remoteParticipants.values()).some(
        (p) => isTeacherParticipant(p, teacherSet) && !!p.getTrackPublication(Track.Source.ScreenShare)
      );
      for (const p of Array.from(room.remoteParticipants.values())) {
        const isTeacherP = isTeacherParticipant(p, teacherSet);
        if (isTeacherP) teachers.add(p.identity);
        else classmates.add(p.identity);
        if (isTeacherP) {
          const cam = p.getTrackPublication(Track.Source.Camera);
          if (cam) {
            try {
              cam.setVideoQuality(sharing ? VideoQuality.LOW : VideoQuality.HIGH);
            } catch {
              /* not subscribed yet */
            }
          }
        }
        for (const pub of Array.from(p.trackPublications.values())) {
          const spotlightCam = !!spotlightIdentity && p.identity === spotlightIdentity && pub.source === Track.Source.Camera;
          const want = isTeacherP || pub.source === Track.Source.Microphone || spotlightCam;
          if (pub.isSubscribed !== want) {
            try {
              pub.setSubscribed(want);
            } catch (e) {
              console.warn('subscription', e);
            }
          }
        }
      }

      const me = room.localParticipant;
      classmates.delete(me.identity);
      for (const t of Array.from(teachers)) classmates.delete(t);
      const micSid = me.getTrackPublication(Track.Source.Microphone)?.trackSid;
      const camSid = me.getTrackPublication(Track.Source.Camera)?.trackSid;
      const spotlighted = !!spotlightIdentity && me.identity === spotlightIdentity;
      const perms: ParticipantTrackPermission[] = Array.from(teachers)
        .sort()
        .map((identity) => ({ participantIdentity: identity, allowAll: true }));
      const classmateSids = [
        ...(micSid ? [micSid] : []),
        ...(spotlighted && camSid ? [camSid] : []),
      ];
      if (classmateSids.length) {
        for (const identity of Array.from(classmates).sort()) {
          perms.push({ participantIdentity: identity, allowAll: false, allowedTrackSids: classmateSids });
        }
      }
      const key = JSON.stringify(perms);
      if (key === lastPermKey.current) return;
      lastPermKey.current = key;
      try {
        me.setTrackSubscriptionPermissions(false, perms);
      } catch (e) {
        lastPermKey.current = '';
        console.warn('track subscription permissions', e);
      }
    };

    const resync = () => {
      lastPermKey.current = '';
      sync();
    };

    sync();
    room.on(RoomEvent.Connected, resync);
    room.on(RoomEvent.Reconnected, resync);
    room.on(RoomEvent.ParticipantConnected, sync);
    room.on(RoomEvent.ParticipantDisconnected, sync);
    room.on(RoomEvent.TrackPublished, sync);
    room.on(RoomEvent.TrackUnpublished, sync);
    room.on(RoomEvent.TrackSubscribed, sync);
    room.on(RoomEvent.LocalTrackPublished, sync);
    room.on(RoomEvent.LocalTrackUnpublished, sync);
    const iv = window.setInterval(sync, 3000);
    return () => {
      room.off(RoomEvent.Connected, resync);
      room.off(RoomEvent.Reconnected, resync);
      room.off(RoomEvent.ParticipantConnected, sync);
      room.off(RoomEvent.ParticipantDisconnected, sync);
      room.off(RoomEvent.TrackUnpublished, sync);
      room.off(RoomEvent.TrackSubscribed, sync);
      room.off(RoomEvent.TrackPublished, sync);
      room.off(RoomEvent.LocalTrackPublished, sync);
      room.off(RoomEvent.LocalTrackUnpublished, sync);
      window.clearInterval(iv);
    };
  }, [room, teacherKey, studentKey, spotlightIdentity]);

  return null;
}

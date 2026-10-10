'use client';

import { useEffect } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, Track, VideoQuality, type RemoteTrackPublication } from 'livekit-client';
import { teacherVideoDemand, type DataSaverMode } from '@/lib/dataSaver';
import { isTeacherParticipant } from './ClassroomRoom';

/**
 * Student side: what to receive of the teacher's video (lib/dataSaver).
 * Camera: disabled at the SFU while the floating teacher video is minimized
 * or the student picked "Audio + share only" (stays subscribed, so the
 * privacy sync is untouched and resume is instant). Low quality: LOW layer
 * for camera and share (combined with adaptiveStream, the smaller wins).
 */
export function TeacherMediaDemand({
  teacherIdentities,
  mode,
  camPaneMinimized,
}: {
  teacherIdentities: string[];
  mode: DataSaverMode;
  camPaneMinimized: boolean;
}) {
  const room = useRoomContext();
  const key = teacherIdentities.join(',');
  useEffect(() => {
    if (!room) return;
    const teacherSet = new Set(key ? key.split(',') : []);
    const want = teacherVideoDemand({ mode, camPaneMinimized });
    const apply = () => {
      for (const p of Array.from(room.remoteParticipants.values())) {
        if (!isTeacherParticipant(p, teacherSet)) continue;
        for (const pub of Array.from(p.trackPublications.values()) as RemoteTrackPublication[]) {
          try {
            if (pub.source === Track.Source.Camera) {
              if (pub.isEnabled !== want.cameraEnabled) pub.setEnabled(want.cameraEnabled);
              pub.setVideoQuality(want.cameraLow ? VideoQuality.LOW : VideoQuality.HIGH);
            } else if (pub.source === Track.Source.ScreenShare) {
              pub.setVideoQuality(want.shareLow ? VideoQuality.LOW : VideoQuality.HIGH);
            }
          } catch {
            /* not subscribed yet: TrackSubscribed re-applies */
          }
        }
      }
    };
    apply();
    room.on(RoomEvent.TrackSubscribed, apply);
    room.on(RoomEvent.TrackPublished, apply);
    return () => {
      room.off(RoomEvent.TrackSubscribed, apply);
      room.off(RoomEvent.TrackPublished, apply);
    };
  }, [room, key, mode, camPaneMinimized]);
  return null;
}

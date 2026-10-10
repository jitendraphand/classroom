'use client';

import { useEffect, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, Track, VideoQuality, type RemoteTrackPublication } from 'livekit-client';
import { teacherVideoDemand, type DataSaverMode } from '@/lib/dataSaver';
import { createStepUp, type LinkPhase } from '@/lib/reconnectQuality';
import { SMALL_SCREEN_SHARE_DIMENSIONS, isSmallScreen, shareLayerFor } from '@/lib/subscriberCodecs';
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
  // Smart reconnect: after a reconnect / network change resume on low layers,
  // step up once the link has been quiet for a few seconds.
  const [phase, setPhase] = useState<LinkPhase>('stable');
  useEffect(() => {
    if (!room) return;
    const step = createStepUp(setPhase);
    const disturbed = () => step.disturbed();
    const connected = () => step.connected();
    const netChange = () => {
      step.disturbed();
      if (room.state === 'connected') step.connected();
    };
    room.on(RoomEvent.Reconnecting, disturbed);
    room.on(RoomEvent.SignalReconnecting, disturbed);
    room.on(RoomEvent.Reconnected, connected);
    window.addEventListener('online', netChange);
    const conn = (navigator as Navigator & { connection?: EventTarget }).connection;
    conn?.addEventListener?.('change', netChange);
    return () => {
      room.off(RoomEvent.Reconnecting, disturbed);
      room.off(RoomEvent.SignalReconnecting, disturbed);
      room.off(RoomEvent.Reconnected, connected);
      window.removeEventListener('online', netChange);
      conn?.removeEventListener?.('change', netChange);
      step.dispose();
    };
  }, [room]);
  const recovering = phase === 'recovering';
  useEffect(() => {
    if (!room) return;
    const teacherSet = new Set(key ? key.split(',') : []);
    const base = teacherVideoDemand({ mode, camPaneMinimized });
    const screen = {
      coarse: !!window.matchMedia?.('(pointer: coarse)').matches,
      screenW: window.screen?.width || 0,
      screenH: window.screen?.height || 0,
    };
    // Phones / small screens: the 720p share layer (explicit cap on top of
    // adaptive stream); everyone on low layers while a reconnect settles.
    const small = isSmallScreen(screen);
    const want = {
      ...base,
      cameraLow: base.cameraLow || recovering,
      shareLow: shareLayerFor(screen, base.shareLow) === 'low' || recovering,
    };
    const apply = () => {
      for (const p of Array.from(room.remoteParticipants.values())) {
        if (!isTeacherParticipant(p, teacherSet)) continue;
        for (const pub of Array.from(p.trackPublications.values()) as RemoteTrackPublication[]) {
          try {
            if (pub.source === Track.Source.Camera) {
              if (pub.isEnabled !== want.cameraEnabled) pub.setEnabled(want.cameraEnabled);
              pub.setVideoQuality(want.cameraLow ? VideoQuality.LOW : VideoQuality.HIGH);
            } else if (pub.source === Track.Source.ScreenShare) {
              if (small) {
                // Explicit 720p request: takes precedence over adaptive stream,
                // which reports 0x0 (paused) until the first frame sizes the
                // element, so the H.264 backup would never start.
                pub.setVideoDimensions(SMALL_SCREEN_SHARE_DIMENSIONS);
              } else {
                pub.setVideoQuality(want.shareLow ? VideoQuality.LOW : VideoQuality.HIGH);
              }
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
  }, [room, key, mode, camPaneMinimized, recovering]);
  return null;
}

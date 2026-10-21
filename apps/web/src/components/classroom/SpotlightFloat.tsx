'use client';

import { useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, Track } from 'livekit-client';
import { useFloatDrag, type FloatPos } from './FloatingPanel';

/** One classmate camera, shown only while the teacher spotlights them. */
export function SpotlightFloat({
  identity,
  name,
  hidden = false,
}: {
  identity: string;
  name: string;
  /** Same drop as the roster: unsubscribe and show nothing until they return. */
  hidden?: boolean;
}) {
  const room = useRoomContext();
  const paneRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [tick, setTick] = useState(0);
  const defaultPos = (): FloatPos => ({ x: 16, y: 88 });
  const { pos, handleProps } = useFloatDrag({ id: 'spotlight_student', paneRef, defaultPos });

  useEffect(() => {
    if (!room) return;
    if (hidden) {
      const p = room.remoteParticipants.get(identity);
      if (p) {
        for (const pub of Array.from(p.trackPublications.values())) {
          if (!pub.isSubscribed) continue;
          try {
            pub.setSubscribed(false);
          } catch {
            /* the class panel retries while the student stays dropped */
          }
        }
      }
      return;
    }
    const bump = () => setTick((n) => n + 1);
    const subscribe = () => {
      const p = room.remoteParticipants.get(identity);
      const pub = p?.getTrackPublication(Track.Source.Camera);
      if (pub && !pub.isSubscribed) {
        try {
          pub.setSubscribed(true);
        } catch {
          /* privacy sync retries */
        }
      }
      bump();
    };
    subscribe();
    room.on(RoomEvent.TrackPublished, subscribe);
    room.on(RoomEvent.TrackSubscribed, bump);
    room.on(RoomEvent.TrackUnsubscribed, bump);
    room.on(RoomEvent.TrackMuted, bump);
    room.on(RoomEvent.TrackUnmuted, subscribe);
    room.on(RoomEvent.ParticipantConnected, subscribe);
    room.on(RoomEvent.ParticipantDisconnected, bump);
    return () => {
      room.off(RoomEvent.TrackPublished, subscribe);
      room.off(RoomEvent.TrackSubscribed, bump);
      room.off(RoomEvent.TrackUnsubscribed, bump);
      room.off(RoomEvent.TrackMuted, bump);
      room.off(RoomEvent.TrackUnmuted, subscribe);
      room.off(RoomEvent.ParticipantConnected, subscribe);
      room.off(RoomEvent.ParticipantDisconnected, bump);
    };
  }, [room, identity, hidden]);

  void tick;
  const participant = hidden ? undefined : room?.remoteParticipants.get(identity);
  const media = participant?.getTrackPublication(Track.Source.Camera)?.track?.mediaStreamTrack ?? null;
  const label = name || participant?.name || 'Student';

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (!media) {
      el.srcObject = null;
      return;
    }
    el.srcObject = new MediaStream([media]);
    void el.play().catch(() => {});
    return () => {
      el.srcObject = null;
    };
  }, [media]);

  if (hidden) return null;

  const style = pos ? { left: pos.x, top: pos.y, zIndex: 45 } : { left: 16, top: 88, zIndex: 45 };

  return (
    <div
      ref={paneRef}
      className="student-media-float"
      style={style}
      data-testid="spotlight-float"
      aria-label={`Spotlight ${label}`}
    >
      <div className="student-media-head" {...handleProps} title="Drag to move">
        <span className="student-media-title">
          <span aria-hidden className="mr-1 text-white/40">
            ⠿
          </span>
          {label}
        </span>
      </div>
      <div className="student-media-row">
        <div className="student-media-tile" aria-label={`${label} camera`}>
          {media ? (
            <video ref={videoRef} className="pointer-events-none h-full w-full object-cover" autoPlay playsInline muted />
          ) : (
            <div className="flex h-full items-center justify-center px-2 text-center text-[10px] text-slate-300">
              Camera off
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

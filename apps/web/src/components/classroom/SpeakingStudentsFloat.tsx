'use client';

/**
 * Teacher only (Nov 25): every student the teacher has unmuted pops up here
 * with their camera, and leaves when muted again. Unmute needs the camera on,
 * and a camera-off auto-mutes, so each speaker normally has video. Students
 * never get this window: classmates' cameras stay private (StudentMediaPrivacy),
 * except a spotlighted student.
 */
import { useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, Track } from 'livekit-client';
import { useFloatDrag, type FloatPos } from './FloatingPanel';
import { MEETING_BAR_PX } from '@/lib/shareChrome';
import { speakingFloatState } from '@/lib/speakingRules';

export type Speaker = { identity: string; name: string };

/** Tiles shown at once; the rest are listed as "+N". */
const MAX_TILES = 4;

function SpeakerTile({ identity, name }: Speaker) {
  const room = useRoomContext();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!room) return;
    const bump = () => setTick((n) => n + 1);
    const subscribe = () => {
      const pub = room.remoteParticipants.get(identity)?.getTrackPublication(Track.Source.Camera);
      if (pub && !pub.isSubscribed) {
        try {
          pub.setSubscribed(true);
        } catch {
          /* the class panel's subscription sync retries */
        }
      }
      bump();
    };
    subscribe();
    const evs = [RoomEvent.TrackPublished, RoomEvent.TrackUnmuted, RoomEvent.ParticipantConnected] as const;
    const bumps = [RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed, RoomEvent.TrackMuted, RoomEvent.ParticipantDisconnected] as const;
    evs.forEach((e) => room.on(e, subscribe));
    bumps.forEach((e) => room.on(e, bump));
    return () => {
      evs.forEach((e) => room.off(e, subscribe));
      bumps.forEach((e) => room.off(e, bump));
    };
  }, [room, identity]);

  void tick;
  const pub = room?.remoteParticipants.get(identity)?.getTrackPublication(Track.Source.Camera);
  const media = pub && !pub.isMuted ? (pub.track?.mediaStreamTrack ?? null) : null;

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

  return (
    <div className="student-media-tile speaking-tile" aria-label={`${name} camera`} data-testid="speaking-tile">
      {media ? (
        <video ref={videoRef} className="pointer-events-none h-full w-full object-cover" autoPlay playsInline muted />
      ) : (
        <div className="flex h-full items-center justify-center px-2 text-center text-[10px] text-slate-300">Connecting…</div>
      )}
      <span className="speaking-tile-name">{name}</span>
    </div>
  );
}

export function SpeakingStudentsFloat({ speakers, whiteboard = false }: { speakers: readonly Speaker[]; whiteboard?: boolean }) {
  const paneRef = useRef<HTMLDivElement | null>(null);
  // Closed by the teacher: stays closed until someone new is unmuted.
  const [closedFor, setClosedFor] = useState<string[] | null>(null);
  const ids = speakers.map((s) => s.identity);
  const view = speakingFloatState(ids, closedFor);
  useEffect(() => {
    if (closedFor && view.reopen) setClosedFor(null);
  }, [closedFor, view.reopen]);
  const defaultPos = (): FloatPos => ({
    x: Math.max(8, (typeof window === 'undefined' ? 1200 : window.innerWidth) - (whiteboard ? MEETING_BAR_PX : 0) - 200),
    y: 72,
  });
  const { pos, handleProps } = useFloatDrag({
    id: 'speaking_students',
    paneRef,
    defaultPos,
    extraInsets: whiteboard ? () => ({ right: MEETING_BAR_PX }) : undefined,
    insetKey: whiteboard ? 'wb' : '',
  });
  if (!view.open) return null;
  const shown = speakers.slice(0, MAX_TILES);
  const more = speakers.length - shown.length;
  const style = pos ? { left: pos.x, top: pos.y, zIndex: 46 } : { right: 16, top: 72, zIndex: 46 };
  return (
    <div ref={paneRef} className="student-media-float" style={style} data-testid="speaking-float" aria-label="Unmuted students">
      <div className="student-media-head" {...handleProps} title="Drag to move">
        <span className="student-media-title">
          <span aria-hidden className="mr-1 text-white/40">
            ⠿
          </span>
          Speaking ({speakers.length})
        </span>
        <button
          type="button"
          className="student-media-btn"
          data-no-drag
          aria-label="Close speaking videos"
          title="Close (opens again when you unmute someone else)"
          onClick={() => setClosedFor(ids)}
        >
          ✕
        </button>
      </div>
      <div className="student-media-row">
        {shown.map((s) => (
          <SpeakerTile key={s.identity} identity={s.identity} name={s.name} />
        ))}
        {more > 0 && <span className="px-1 text-[10px] text-slate-300">+{more} more unmuted</span>}
      </div>
    </div>
  );
}

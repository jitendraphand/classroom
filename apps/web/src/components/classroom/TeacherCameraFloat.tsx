'use client';

/**
 * Floating teacher camera tile on the student view. (Split out of
 * ClassroomRoom.tsx.)
 */
import { useRoomContext } from '@livekit/components-react';
import { Track, RoomEvent } from 'livekit-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFloatDrag, type FloatPos } from './FloatingPanel';
import { useDataSaver } from '@/hooks/useDataSaver';
import { TeacherMediaDemand } from './TeacherMediaDemand';
import { type StudentVideoMode } from '@/lib/studentVideoMode';
import { isTeacherParticipant } from './participantRoles';

export function TeacherCameraFloat({
  teacherIdentities,
  roomCode,
  selfName,
  selfStream,
  camOn,
  mode,
  teacherOnStage = false,
}: {
  teacherIdentities: string[];
  roomCode: string;
  selfName: string;
  selfStream: MediaStream | null;
  camOn: boolean;
  /** both = teacher + self, teacher = teacher only, min = draggable "Videos" pill. */
  mode: StudentVideoMode;
  /** The stage already shows the teacher camera (nothing shared): no teacher tile here. */
  teacherOnStage?: boolean;
}) {
  const [dataSaver] = useDataSaver();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const selfVideoRef = useRef<HTMLVideoElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const minimized = mode === 'min';
  const showSelf = mode === 'both';

  // Bottom-right by default (clamped above the control bar by the hook).
  const defaultPos = useCallback(
    (): FloatPos => ({ x: window.innerWidth - 372, y: window.innerHeight - 200 }),
    []
  );
  const { pos, handleProps } = useFloatDrag({ id: 'student_videos', paneRef, defaultPos });

  const { mediaTrack, teacherName } = useTeacherCamera(teacherIdentities);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (!mediaTrack) {
      el.srcObject = null;
      return;
    }
    el.srcObject = new MediaStream([mediaTrack]);
    void el.play().catch(() => {});
    return () => {
      el.srcObject = null;
    };
  }, [mediaTrack, mode, teacherOnStage]);

  const hasVideo = !!mediaTrack;

  useEffect(() => {
    const el = selfVideoRef.current;
    if (!el) return;
    const track = selfStream?.getVideoTracks().find((t) => t.readyState === 'live') ?? null;
    if (!track || !showSelf || minimized) {
      el.srcObject = null;
      return;
    }
    el.srcObject = new MediaStream([track]);
    void el.play().catch(() => {});
    return () => {
      el.srcObject = null;
    };
  }, [selfStream, showSelf, minimized, camOn]);

  // Item 13: on a portrait phone the default spot (bottom-right) sat on top of
  // the 16:9 board. The free band above the board fits the tiles in a row.
  const portraitPhone =
    typeof window !== 'undefined' && window.innerWidth <= 700 && window.innerHeight > window.innerWidth;
  const style = pos ? { left: pos.x, top: pos.y } : portraitPhone ? { left: 8, top: 96 } : { right: 12, bottom: 88 };

  const demand = <TeacherMediaDemand teacherIdentities={teacherIdentities} mode={dataSaver} camPaneMinimized={minimized} />;
  if (teacherOnStage && !minimized && !showSelf) return demand;

  return (
    <>
    {demand}
    <div
      ref={paneRef}
      className="student-media-float"
      data-minimized={minimized ? '1' : '0'}
      data-room={roomCode}
      data-video-mode={mode}
      style={style}
      aria-label="Videos — drag the top bar to move"
    >
      {minimized ? (
        <div className="student-media-restore" {...handleProps} title="Drag to move">
          <span>Videos</span>
        </div>
      ) : (
        <>
          <div className="student-media-head" {...handleProps} title="Drag to move">
            <span className="student-media-title">
              <span aria-hidden className="mr-1 text-white/40">⠿</span>Videos
            </span>
          </div>
          <div className="student-media-row">
            {!teacherOnStage && (
              <div className="student-media-tile" aria-label="Teacher camera">
                {hasVideo ? (
                  <video
                    ref={videoRef}
                    className="pointer-events-none h-full w-full object-cover"
                    autoPlay
                    playsInline
                    muted
                  />
                ) : (
                  <div className="flex h-full items-start justify-center px-2 pt-2 text-center text-[10px] text-slate-300">
                    Camera off
                  </div>
                )}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-2 pb-1 pt-4">
                  <span className="block truncate text-2xs font-semibold tracking-wide text-white" title={teacherName}>{teacherName}</span>
                </div>
              </div>
            )}
            {showSelf && (
              <div className="student-media-tile" aria-label="Your camera">
                {camOn && selfStream ? (
                  <video
                    ref={selfVideoRef}
                    className="student-media-mirror pointer-events-none h-full w-full object-cover"
                    autoPlay
                    playsInline
                    muted
                  />
                ) : (
                  <div className="flex h-full items-start justify-center px-2 pt-2 text-center text-[10px] text-slate-300">
                    Camera off
                  </div>
                )}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-1.5 pb-1 pt-4">
                  <span className="block truncate text-2xs font-semibold text-white">{selfName || 'Me'}</span>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
    </>
  );
}

/**
 * The teacher's live camera track (subscribing it if needed), re-read on
 * every track / participant event. Null while the camera is off or muted.
 */
function useTeacherCamera(teacherIdentities: string[]): { mediaTrack: MediaStreamTrack | null; teacherName: string } {
  const room = useRoomContext();
  const teacherSet = useMemo(() => new Set(teacherIdentities), [teacherIdentities]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!room) return;
    const bump = () => setTick((n) => n + 1);
    /** Subscribes any missing teacher camera; true when it had to. */
    const subscribeMissing = () => {
      let did = false;
      for (const p of Array.from(room.remoteParticipants.values())) {
        if (!isTeacherParticipant(p, teacherSet)) continue;
        const pub = p.getTrackPublication(Track.Source.Camera);
        if (pub && !pub.isSubscribed) {
          did = true;
          try {
            pub.setSubscribed(true);
          } catch (e) {
            console.warn('subscribe teacher cam', e);
          }
        }
      }
      return did;
    };
    const ensure = () => {
      subscribeMissing();
      bump();
    };
    ensure();
    room.on(RoomEvent.TrackPublished, ensure);
    room.on(RoomEvent.TrackUnpublished, bump);
    room.on(RoomEvent.TrackSubscribed, ensure);
    room.on(RoomEvent.TrackUnsubscribed, bump);
    room.on(RoomEvent.TrackMuted, bump);
    room.on(RoomEvent.TrackUnmuted, ensure);
    room.on(RoomEvent.ParticipantConnected, ensure);
    room.on(RoomEvent.ParticipantDisconnected, bump);
    room.on(RoomEvent.TrackSubscriptionFailed, ensure);
    // Safety net only: events above drive re-renders, so the timer re-renders
    // only when it actually had to subscribe something.
    const iv = window.setInterval(() => {
      if (subscribeMissing()) bump();
    }, 3000);
    return () => {
      room.off(RoomEvent.TrackPublished, ensure);
      room.off(RoomEvent.TrackUnpublished, bump);
      room.off(RoomEvent.TrackSubscribed, ensure);
      room.off(RoomEvent.TrackUnsubscribed, bump);
      room.off(RoomEvent.TrackMuted, bump);
      room.off(RoomEvent.TrackUnmuted, ensure);
      room.off(RoomEvent.ParticipantConnected, ensure);
      room.off(RoomEvent.ParticipantDisconnected, bump);
      room.off(RoomEvent.TrackSubscriptionFailed, ensure);
      window.clearInterval(iv);
    };
  }, [room, teacherSet]);

  void tick;

  let teacherPub: {
    track?: { mediaStreamTrack?: MediaStreamTrack } | null;
    isSubscribed?: boolean;
    isMuted?: boolean;
  } | null = null;
  let teacherName = 'Teacher';
  if (room) {
    for (const p of Array.from(room.remoteParticipants.values())) {
      if (!isTeacherParticipant(p, teacherSet)) continue;
      teacherName = p.name || p.identity || 'Teacher';
      const pub = p.getTrackPublication(Track.Source.Camera);
      // Only treat as published when the camera track is live (not muted/unpublished).
      if (pub && !pub.isMuted && pub.track) {
        teacherPub = pub;
      }
      break;
    }
  }

  return { mediaTrack: teacherPub?.track?.mediaStreamTrack ?? null, teacherName };
}

/**
 * Student stage while nothing is shared: the teacher's camera fills it (on a
 * phone the float alone left ~70% of the screen empty). Same track and
 * quality as the float, so no extra bandwidth; the float drops its teacher
 * tile meanwhile.
 */
export function TeacherStageCamera({ teacherIdentities, fallback }: { teacherIdentities: string[]; fallback: string }) {
  const [dataSaver] = useDataSaver();
  const { mediaTrack, teacherName } = useTeacherCamera(teacherIdentities);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const live = dataSaver !== 'share-only' ? mediaTrack : null;
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !live) return;
    el.srcObject = new MediaStream([live]);
    void el.play().catch(() => {});
    return () => {
      el.srcObject = null;
    };
  }, [live]);
  if (!live) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-ink-950 px-6 text-center text-slate-400">
        <p className="font-display text-lg font-semibold text-slate-200">{teacherName}</p>
        <p className="max-w-sm text-sm">
          {dataSaver === 'share-only' ? 'Teacher camera is off to save data. ' : 'Camera is off. '}
          {fallback}
        </p>
      </div>
    );
  }
  return (
    <div className="relative h-full w-full bg-black" data-testid="teacher-stage-camera" aria-label={`${teacherName}, camera`}>
      {/* No name overlay: the floats and controls cover the stage's edges. */}
      <video ref={videoRef} className="pointer-events-none h-full w-full object-contain" autoPlay playsInline muted />
    </div>
  );
}

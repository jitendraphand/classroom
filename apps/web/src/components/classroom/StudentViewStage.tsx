'use client';

import {
  type TrackReference,
  useRemoteParticipants,
  useRoomContext,
  VideoTrack,
} from '@livekit/components-react';
import { WhiteboardViewer } from './Whiteboard';
import { RoomEvent, Track, VideoQuality, type RemoteParticipant } from 'livekit-client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
/** Mirrors SCREEN_SIDECAR_SUFFIX in lib/livekit (server-only module). */
const SCREEN_SIDECAR_SUFFIX = '__screen';
import { IconScreen } from '@/components/ui/Icons';
import { cn } from '@/lib/cn';
import { TeacherScreenStage } from './ClassroomRoom';
import { isTeacherParticipant } from './participantRoles';
import { useFloatDrag } from './FloatingPanel';

/**
 * What a student sees on the main stage, for someone who is *not* a student
 * (the admin's "Ongoing classes" tiles and observer view). Same precedence and
 * placeholders as the student stage in ClassroomRoom:
 *   teacher screen share → teacher camera → "Teacher camera off" / "Waiting for teacher…".
 *
 * Connect the surrounding LiveKitRoom with `autoSubscribe: false`; this
 * component subscribes to teacher tracks only. Student tracks are never
 * requested (and the students' own subscription permissions would refuse a
 * hidden observer anyway). `preview` subscribes to teacher video only, capped
 * at the low layer, and never to audio; `observe` also takes the teacher's
 * microphone / screen-share audio.
 */
export type StudentViewMode = 'preview' | 'observe';

const NO_TEACHERS = new Set<string>();

/** Share publisher: the teacher's own screen track, or the Windows sidecar `teacher_<id>__screen`. */
function isShareParticipant(identity: string) {
  return identity.startsWith('teacher_') && identity.endsWith(SCREEN_SIDECAR_SUFFIX);
}

function isVideoPub(pub: { source: Track.Source; kind: Track.Kind }) {
  return (
    pub.source === Track.Source.Camera ||
    pub.source === Track.Source.ScreenShare ||
    // Native publishers may leave the source unset; a sidecar only ever shares the screen.
    (pub.source === Track.Source.Unknown && pub.kind === Track.Kind.Video)
  );
}

function isSharePub(p: { identity: string }, pub: { source: Track.Source; kind: Track.Kind }) {
  return (
    pub.source === Track.Source.ScreenShare ||
    (isShareParticipant(p.identity) && pub.kind === Track.Kind.Video && pub.source !== Track.Source.Camera)
  );
}

function useTeacherOnlySubscriptions(mode: StudentViewMode) {
  const room = useRoomContext();
  // Bumped on every relevant room event so the stage re-reads publications
  // (a published-but-not-yet-subscribed share must not read as "camera off").
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const sync = () => {
      room.remoteParticipants.forEach((p: RemoteParticipant) => {
        const teacher = isTeacherParticipant(p, NO_TEACHERS);
        p.trackPublications.forEach((pub) => {
          const video = isVideoPub(pub);
          const audio =
            pub.source === Track.Source.Microphone || pub.source === Track.Source.ScreenShareAudio;
          const want = teacher && (video || (audio && mode === 'observe'));
          if (pub.isDesired !== want) pub.setSubscribed(want);
          if (want && video && mode === 'preview') pub.setVideoQuality(VideoQuality.LOW);
        });
      });
      setVersion((v) => v + 1);
    };
    sync();
    const events = [
      RoomEvent.Connected,
      RoomEvent.Reconnected,
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.ParticipantMetadataChanged,
      RoomEvent.TrackPublished,
      RoomEvent.TrackUnpublished,
      RoomEvent.TrackSubscribed,
      RoomEvent.TrackUnsubscribed,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
    ] as const;
    events.forEach((e) => room.on(e, sync));
    return () => {
      events.forEach((e) => room.off(e, sync));
    };
  }, [room, mode]);
  return version;
}

export function StudentViewStage({
  code,
  mode,
  className,
}: {
  code: string;
  mode: StudentViewMode;
  className?: string;
}) {
  useTeacherOnlySubscriptions(mode);
  const room = useRoomContext();
  const wbOn = useAdminWhiteboardFlag(code);
  const compact = mode === 'preview';
  const remotes = useRemoteParticipants();
  const teachers = Array.from(room.remoteParticipants.values()).filter((p) => isTeacherParticipant(p, NO_TEACHERS));
  const teacherHere = teachers.length > 0 || remotes.some((p) => isTeacherParticipant(p, NO_TEACHERS));

  // Pick tracks straight from the teacher participants (incl. the share sidecar):
  // screen share first (sidecar or the teacher's own), camera as fallback.
  let screen: TrackReference | undefined;
  let camera: TrackReference | undefined;
  let sharePublished = false;
  for (const p of teachers) {
    p.trackPublications.forEach((pub) => {
      if (!isVideoPub(pub) || pub.isMuted) return;
      const share = isSharePub(p, pub);
      if (share) sharePublished = true;
      if (!pub.isSubscribed || !pub.track) return;
      const ref: TrackReference = { participant: p, publication: pub, source: pub.source };
      if (share) {
        if (!screen || isShareParticipant(p.identity)) screen = ref;
      } else if (pub.source === Track.Source.Camera && !camera && !isShareParticipant(p.identity)) camera = ref;
    });
  }
  const placeholder = sharePublished
    ? 'Teacher is sharing the screen…'
    : teacherHere
      ? 'Teacher camera off'
      : 'Waiting for teacher…';

  if (wbOn) {
    const ask = () =>
      void fetch(`/api/admin/live/${encodeURIComponent(code)}/whiteboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: room.localParticipant.identity }),
      }).catch(() => undefined);
    return (
      <div className={cn('relative h-full w-full overflow-hidden bg-ink-950', className)} data-admin-whiteboard="1">
        <WhiteboardViewer identity={room.localParticipant.identity} canAnnotate={false} requestSnapshot={ask} />
      </div>
    );
  }

  return (
    <div className={cn('relative h-full w-full overflow-hidden bg-ink-950', className)}>
      {screen ? (
        <>
          {screen.source === Track.Source.ScreenShare && !compact ? (
            <TeacherScreenStage teacherIdentities={[]} />
          ) : (
            <VideoTrack trackRef={screen} className="h-full w-full bg-black object-contain" />
          )}
          {!compact && camera && (
            <ObserverCameraFloat>
              <VideoTrack trackRef={camera} className="pointer-events-none h-full w-full object-cover" />
            </ObserverCameraFloat>
          )}
        </>
      ) : camera ? (
        <VideoTrack trackRef={camera} className="h-full w-full bg-black object-contain" />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-3 text-center text-slate-400">
          <IconScreen size={compact ? 22 : 32} />
          <p className={compact ? 'text-xs' : 'text-sm'}>{placeholder}</p>
        </div>
      )}
    </div>
  );
}

/** Teacher camera over the observed share: drag it anywhere (mouse or touch). */
function ObserverCameraFloat({ children }: { children: ReactNode }) {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const defaultPos = useCallback(() => ({ x: window.innerWidth - 232, y: window.innerHeight - 150 }), []);
  const { pos, handleProps } = useFloatDrag({ id: 'observer_teacher_cam', paneRef, defaultPos });
  return (
    <div
      ref={paneRef}
      {...handleProps}
      title="Drag to move"
      className="fixed z-[35] aspect-video w-40 overflow-hidden rounded-xl border border-white/15 bg-black shadow-lg sm:w-52"
      style={pos ? { left: pos.x, top: pos.y } : { right: 12, bottom: 12 }}
    >
      {children}
    </div>
  );
}

/** Admin viewers: is the class whiteboard open? (polled; the board itself arrives over LiveKit data). */
function useAdminWhiteboardFlag(code: string): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let stop = false;
    const check = () =>
      fetch(`/api/admin/live/${encodeURIComponent(code)}/whiteboard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!stop && d) setOn(!!d.on);
        })
        .catch(() => undefined);
    void check();
    const iv = window.setInterval(check, 8000);
    return () => {
      stop = true;
      window.clearInterval(iv);
    };
  }, [code]);
  return on;
}

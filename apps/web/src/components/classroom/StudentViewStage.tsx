'use client';

import {
  isTrackReference,
  useRemoteParticipants,
  useRoomContext,
  useTracks,
  VideoTrack,
} from '@livekit/components-react';
import { RoomEvent, Track, VideoQuality, type RemoteParticipant } from 'livekit-client';
import { useEffect } from 'react';
import { IconScreen } from '@/components/ui/Icons';
import { cn } from '@/lib/cn';
import { isTeacherParticipant, TeacherScreenStage } from './ClassroomRoom';

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

function useTeacherOnlySubscriptions(mode: StudentViewMode) {
  const room = useRoomContext();
  useEffect(() => {
    const sync = () => {
      room.remoteParticipants.forEach((p: RemoteParticipant) => {
        const teacher = isTeacherParticipant(p, NO_TEACHERS);
        p.trackPublications.forEach((pub) => {
          const video = pub.source === Track.Source.Camera || pub.source === Track.Source.ScreenShare;
          const audio =
            pub.source === Track.Source.Microphone || pub.source === Track.Source.ScreenShareAudio;
          const want = teacher && (video || (audio && mode === 'observe'));
          if (pub.isDesired !== want) pub.setSubscribed(want);
          if (want && video && mode === 'preview') pub.setVideoQuality(VideoQuality.LOW);
        });
      });
    };
    sync();
    const events = [
      RoomEvent.Connected,
      RoomEvent.Reconnected,
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantMetadataChanged,
      RoomEvent.TrackPublished,
      RoomEvent.TrackSubscribed,
    ] as const;
    events.forEach((e) => room.on(e, sync));
    return () => {
      events.forEach((e) => room.off(e, sync));
    };
  }, [room, mode]);
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
  const compact = mode === 'preview';
  const remotes = useRemoteParticipants();
  const teacherHere = remotes.some((p) => isTeacherParticipant(p, NO_TEACHERS));
  const tracks = useTracks(
    [
      { source: Track.Source.ScreenShare, withPlaceholder: false },
      { source: Track.Source.Camera, withPlaceholder: false },
    ],
    { onlySubscribed: true }
  );
  const teacherTracks = tracks.filter(isTrackReference).filter(
    (t) => !t.participant.isLocal && isTeacherParticipant(t.participant, NO_TEACHERS) && !t.publication?.isMuted
  );
  const screen = teacherTracks.find((t) => t.source === Track.Source.ScreenShare);
  const camera = teacherTracks.find((t) => t.source === Track.Source.Camera);

  return (
    <div className={cn('relative h-full w-full overflow-hidden bg-ink-950', className)}>
      {screen ? (
        <>
          {/* Read-only annotation layer only in the full observer view. */}
          <TeacherScreenStage teacherIdentities={[]} code={code} active={!compact} />
          {!compact && camera && (
            <div className="absolute bottom-3 right-3 aspect-video w-40 overflow-hidden rounded-xl border border-white/15 bg-black shadow-lg sm:w-52">
              <VideoTrack trackRef={camera} className="h-full w-full object-cover" />
            </div>
          )}
        </>
      ) : camera ? (
        <VideoTrack trackRef={camera} className="h-full w-full bg-black object-contain" />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-3 text-center text-slate-400">
          <IconScreen size={compact ? 22 : 32} />
          <p className={compact ? 'text-xs' : 'text-sm'}>{teacherHere ? 'Teacher camera off' : 'Waiting for teacher…'}</p>
        </div>
      )}
    </div>
  );
}

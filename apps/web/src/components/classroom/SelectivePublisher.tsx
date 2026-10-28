'use client';

/**
 * Publishes this participant's camera (only while allowed: teacher, or a
 * student in the visible sample with the panel shown) and microphone,
 * following the SFU grant. (Split out of ClassroomRoom.tsx.)
 */
import { useLocalParticipant, useRoomContext } from '@livekit/components-react';
import {
  Track,
  LocalVideoTrack,
  createLocalAudioTrack,
  LocalAudioTrack,
  RoomEvent,
  AudioPresets,
  VideoPreset,
  type Participant,
} from 'livekit-client';
import { useEffect, useRef, useState } from 'react';
import { MIC_CAPTURE } from '@/lib/audioPolicy';
import { cameraProfile, studentCamera, teacherCamera } from '@/lib/videoQuality';
import { withNegotiationRetry } from '@/lib/joinPacingLogic';
import { enqueueLocalPublish, safeStop, unpublishThenStop } from './localPublish';

/** Human-readable camera failure. Shown instead of publishing a fake camera. */
export function cameraErrorMessage(err: unknown): string {
  const name =
    err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera access was blocked. Allow the camera for this site in your browser settings, then turn the camera on again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No camera was found on this device.';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'The camera is in use by another app or could not be started. Close other apps using it, then turn the camera on again.';
  }
  if (typeof navigator !== 'undefined' && !navigator.mediaDevices?.getUserMedia) {
    return 'This browser cannot open a camera here. Use an https address and a current browser.';
  }
  return 'Could not start the camera.';
}

/**
 * Local camera + mic publishing.
 *
 * The camera is opened ONCE (getUserMedia) for the self-preview. When this
 * client is allowed to publish video, a clone of that same MediaStreamTrack is
 * published: cloning does not open the device a second time, so mobile
 * browsers and drivers that only allow one capture keep working, and stopping
 * the published clone never freezes the preview. If the camera cannot be
 * opened, nothing is published and `onCameraError` explains why.
 */
export function SelectivePublisher({
  isTeacher,
  canPublishVideo,
  camWanted = true,
  mutedByTeacher,
  camDesired,
  micDesired,
  localCamStream,
  setLocalCamStream,
  onCameraError,
}: {
  /** Teacher: 720p simulcast camera; student: small single-layer camera. */
  isTeacher: boolean;
  canPublishVideo: boolean;
  /** Students: send camera video only while the teacher shows it (lib/camOnDemand). */
  camWanted?: boolean;
  mutedByTeacher: boolean;
  camDesired: boolean;
  micDesired: boolean;
  localCamStream: MediaStream | null;
  setLocalCamStream: (s: MediaStream | null) => void;
  onCameraError: (message: string | null) => void;
}) {
  const { localParticipant } = useLocalParticipant();
  const room = useRoomContext();
  const camTrackRef = useRef<LocalVideoTrack | null>(null);
  /** The preview MediaStreamTrack the published clone was made from. */
  const camSourceRef = useRef<MediaStreamTrack | null>(null);
  const micTrackRef = useRef<LocalAudioTrack | null>(null);
  const videoGen = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;

    async function setupLocal() {
      if (!camDesired) {
        localCamStream?.getTracks().forEach((t) => t.stop());
        setLocalCamStream(null);
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: cameraProfile(isTeacher).capture,
          audio: false,
        });
      } catch (deviceErr) {
        console.warn('camera unavailable', deviceErr);
        if (!cancelled) {
          setLocalCamStream(null);
          onCameraError(cameraErrorMessage(deviceErr));
        }
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      onCameraError(null);
      setLocalCamStream(stream);
    }

    void setupLocal();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camDesired]);

  const previewTrack =
    localCamStream?.getVideoTracks().find((t) => t.readyState === 'live') ?? null;

  // A student can learn it entered the sample (server push) a moment before the
  // SFU grants the camera; retry the publish when our permissions change.
  const [permTick, setPermTick] = useState(0);
  useEffect(() => {
    if (!room || isTeacher) return;
    const on = (_prev: unknown, p: Participant) => {
      if (p === room.localParticipant) setPermTick((n) => n + 1);
    };
    room.on(RoomEvent.ParticipantPermissionsChanged, on);
    return () => {
      room.off(RoomEvent.ParticipantPermissionsChanged, on);
    };
  }, [room, isTeacher]);

  useEffect(() => {
    if (!localParticipant || !room) return;
    void permTick;
    const gen = ++videoGen.current;
    const source = camDesired && canPublishVideo ? previewTrack : null;
    const participant = localParticipant;

    void enqueueLocalPublish(async () => {
      if (gen !== videoGen.current) return;

      const current = camTrackRef.current;
      const published = participant.getTrackPublication(Track.Source.Camera);
      if (
        source &&
        current &&
        camSourceRef.current === source &&
        published?.track === current
      ) {
        return; // Already publishing a clone of this preview.
      }

      // Anything else: drop the old clone first (the preview keeps running).
      if (current) {
        camTrackRef.current = null;
        camSourceRef.current = null;
        await unpublishThenStop(participant, current);
      }
      if (!source || source.readyState !== 'live') return;
      if (gen !== videoGen.current) return;

      const clone = source.clone();
      const track = new LocalVideoTrack(clone, undefined, true);
      try {
        // Retry a negotiation timeout (join waves) instead of giving up the camera.
        const camOpts =
          isTeacher
            ? {
                source: Track.Source.Camera,
                simulcast: teacherCamera().simulcast,
                videoEncoding: teacherCamera().encoding,
                videoSimulcastLayers: teacherCamera().layers.map(
                  (l) => new VideoPreset(l.width, l.height, l.maxBitrate, l.maxFramerate)
                ),
              }
            : {
                source: Track.Source.Camera,
                simulcast: studentCamera().simulcast,
                videoEncoding: studentCamera().encoding,
              };
        await withNegotiationRetry(() => participant.publishTrack(track, camOpts), {
          beforeRetry: async () => {
            await participant.unpublishTrack(track, false).catch(() => undefined);
          },
          shouldContinue: () => gen === videoGen.current,
        });
      } catch (e) {
        console.warn('publish video', e);
        await unpublishThenStop(participant, track);
        return;
      }
      if (gen !== videoGen.current) {
        await unpublishThenStop(participant, track);
        return;
      }
      camTrackRef.current = track;
      camSourceRef.current = source;
      if (!isTeacher && !camWantedRef.current) await track.pauseUpstream().catch(() => undefined);
    });
  }, [canPublishVideo, camDesired, previewTrack, localParticipant, room, isTeacher, permTick]);

  // Cameras on demand: pause / resume the published track (no renegotiation).
  const camWantedRef = useRef(camWanted);
  camWantedRef.current = camWanted;
  useEffect(() => {
    if (isTeacher || !localParticipant) return;
    void enqueueLocalPublish(async () => {
      const track = camTrackRef.current;
      if (!track) return;
      try {
        if (camWantedRef.current) {
          if (track.isUpstreamPaused) await track.resumeUpstream();
        } else if (!track.isUpstreamPaused) {
          await track.pauseUpstream();
        }
      } catch (e) {
        console.warn('camera on demand', e);
      }
    });
  }, [camWanted, isTeacher, localParticipant]);

  // Unmount: stop the published clone (the preview stream is stopped by its owner).
  useEffect(() => {
    return () => {
      const track = camTrackRef.current;
      camTrackRef.current = null;
      camSourceRef.current = null;
      safeStop(track);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const participant = localParticipant;
    if (!participant) return;
    void enqueueLocalPublish(async () => {
      if (cancelled) return;
      // Teacher mute is authoritative — never publish audio while mutedByTeacher
      const want = micDesired && !mutedByTeacher;
      if (!want) {
        const track = micTrackRef.current;
        micTrackRef.current = null;
        if (track) {
          await unpublishThenStop(participant, track);
        }
        if (cancelled) return;
        try {
          await participant.setMicrophoneEnabled(false);
        } catch {
          /* publication already removed */
        }
        return;
      }
      try {
        if (!micTrackRef.current) {
          const track = await createLocalAudioTrack({ ...MIC_CAPTURE });
          if (cancelled || mutedByTeacher) {
            safeStop(track);
            return;
          }
          try {
            // Retry a negotiation timeout (join waves) before giving up the mic.
            await withNegotiationRetry(
              () =>
                participant.publishTrack(track, {
                  source: Track.Source.Microphone,
                  audioPreset: AudioPresets.speech,
                  dtx: true,
                  // RED re-sends every Opus frame (~2x audio bitrate). Worth it for
                  // the one teacher voice; students hear each other, so N student
                  // mics with RED cost every listener 2N streams of audio.
                  red: isTeacher,
                }),
              {
                beforeRetry: async () => {
                  await participant.unpublishTrack(track, false).catch(() => undefined);
                },
                shouldContinue: () => !cancelled && !mutedByTeacher,
              }
            );
          } catch (e) {
            safeStop(track);
            throw e;
          }
          if (cancelled || mutedByTeacher) {
            await unpublishThenStop(participant, track);
            return;
          }
          micTrackRef.current = track;
        }
        if (cancelled) return;
        if (mutedByTeacher) {
          await participant.setMicrophoneEnabled(false);
          return;
        }
        await participant.setMicrophoneEnabled(true);
      } catch (e) {
        console.warn('mic', e);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [micDesired, mutedByTeacher, localParticipant, isTeacher]);

  return null;
}

export function CameraErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      className="fixed left-1/2 top-3 z-[70] flex max-w-[min(92vw,34rem)] -translate-x-1/2 items-start gap-3 rounded-xl border border-danger-fg/30 bg-surface-1/95 px-4 py-3 text-sm text-slate-100 shadow-lift backdrop-blur"
    >
      <span className="flex-1">
        <span className="font-semibold text-danger-fg">Camera unavailable. </span>
        {message}
      </span>
      <button
        type="button"
        className="shrink-0 text-xs font-semibold text-slate-300 hover:underline"
        onClick={onDismiss}
      >
        Dismiss
      </button>
    </div>
  );
}

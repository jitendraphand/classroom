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
  LocalAudioTrack,
  RoomEvent,
  AudioPresets,
  VideoPreset,
  type Participant,
} from 'livekit-client';
import { useEffect, useRef, useState } from 'react';
import { createVoiceTrack, onVoiceSettings, voiceKey as currentVoiceKey } from '@/lib/audio/voiceProcessor';
import { cameraProfile, studentCamera, teacherCamera } from '@/lib/videoQuality';
import { withNegotiationRetry } from '@/lib/joinPacingLogic';
import { enqueueLocalPublish, safeStop, unpublishThenStop } from './localPublish';
import { micPublishAllowed, ownMicCurrent } from '@/lib/audioPolicy';
import {
  buildMediaIssue,
  queryMediaPermission,
  withPermissionPrompt,
  type MediaAccessIssue,
} from '@/lib/permissions';

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
 * opened, nothing is published and `onCameraError` / `onCameraIssue` explain why.
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
  onCameraIssue,
  onMicIssue,
  camRetryTick = 0,
  micRetryTick = 0,
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
  onCameraError?: (message: string | null) => void;
  onCameraIssue?: (issue: MediaAccessIssue | null) => void;
  onMicIssue?: (issue: MediaAccessIssue | null) => void;
  camRetryTick?: number;
  micRetryTick?: number;
}) {
  const { localParticipant } = useLocalParticipant();
  const room = useRoomContext();
  const camTrackRef = useRef<LocalVideoTrack | null>(null);
  /** The preview MediaStreamTrack the published clone was made from. */
  const camSourceRef = useRef<MediaStreamTrack | null>(null);
  const micTrackRef = useRef<LocalAudioTrack | null>(null);
  const videoGen = useRef(0);
  const [camRecoveryTick, setCamRecoveryTick] = useState(0);
  // A student can learn it entered the sample (server push) a moment before the
  // SFU grants the camera; retry the publish when our permissions change.
  const [permTick, setPermTick] = useState(0);

  const camDesiredRef = useRef(camDesired);
  camDesiredRef.current = camDesired;
  const micDesiredRef = useRef(micDesired);
  micDesiredRef.current = micDesired;
  const mutedRef = useRef(mutedByTeacher);
  mutedRef.current = mutedByTeacher;
  const localCamRef = useRef(localCamStream);
  localCamRef.current = localCamStream;
  const onCameraIssueRef = useRef(onCameraIssue);
  onCameraIssueRef.current = onCameraIssue;
  const onMicIssueRef = useRef(onMicIssue);
  onMicIssueRef.current = onMicIssue;
  const onCameraErrorRef = useRef(onCameraError);
  onCameraErrorRef.current = onCameraError;

  // Explicit Retry button for microphone.
  useEffect(() => {
    if (micRetryTick > 0) setPermTick((n) => n + 1);
  }, [micRetryTick]);

  // Watch browser permission changes (late grant in site settings → publish without rejoin).
  useEffect(() => {
    let cancelled = false;
    let camStatus: PermissionStatus | null = null;
    let micStatus: PermissionStatus | null = null;
    const onCamChange = () => {
      if (cancelled || !camStatus) return;
      if (camStatus.state === 'granted' && camDesiredRef.current) {
        onCameraErrorRef.current?.(null);
        onCameraIssueRef.current?.(null);
        setCamRecoveryTick((n) => n + 1);
      } else if (camStatus.state === 'denied' && camDesiredRef.current) {
        onCameraIssueRef.current?.(buildMediaIssue({ media: 'camera', permState: 'denied' }));
      }
    };
    const onMicChange = () => {
      if (cancelled || !micStatus) return;
      if (micStatus.state === 'granted' && micDesiredRef.current && !mutedRef.current) {
        onMicIssueRef.current?.(null);
        setPermTick((n) => n + 1);
      } else if (micStatus.state === 'denied' && micDesiredRef.current && !mutedRef.current) {
        onMicIssueRef.current?.(
          buildMediaIssue({ media: 'microphone', permState: 'denied', unmutedPrompt: !isTeacher })
        );
      }
    };
    void queryMediaPermission('camera').then(({ status }) => {
      if (cancelled || !status) return;
      camStatus = status;
      status.addEventListener?.('change', onCamChange);
    });
    void queryMediaPermission('microphone').then(({ status }) => {
      if (cancelled || !status) return;
      micStatus = status;
      status.addEventListener?.('change', onMicChange);
    });
    return () => {
      cancelled = true;
      camStatus?.removeEventListener?.('change', onCamChange);
      micStatus?.removeEventListener?.('change', onMicChange);
    };
  }, [isTeacher]);

  // Camera capture (separate from microphone so denying one never blocks the other).
  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let recoverTimer: number | null = null;

    async function setupLocal() {
      if (!camDesired) {
        localCamRef.current?.getTracks().forEach((t) => t.stop());
        setLocalCamStream(null);
        onCameraErrorRef.current?.(null);
        onCameraIssueRef.current?.(null);
        return;
      }

      // If we already have a live video track (e.g. a late permission event fired), keep it.
      const existingLive = localCamRef.current?.getVideoTracks().some((t) => t.readyState === 'live');
      if (existingLive) {
        onCameraErrorRef.current?.(null);
        onCameraIssueRef.current?.(null);
        return;
      }

      // On iOS Safari, calling getUserMedia while backgrounded rejects; wait until visible.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

      const secure = typeof window === 'undefined' ? true : window.isSecureContext !== false;
      const hasDevices = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
      const pre = await queryMediaPermission('camera');
      if (cancelled) return;
      if (!secure || !hasDevices) {
        setLocalCamStream(null);
        onCameraErrorRef.current?.(cameraErrorMessage(null));
        onCameraIssueRef.current?.(
          buildMediaIssue({ media: 'camera', permState: pre.state, secureContext: secure, hasMediaDevices: hasDevices })
        );
        return;
      }
      if (pre.state === 'denied') {
        setLocalCamStream(null);
        onCameraErrorRef.current?.(cameraErrorMessage({ name: 'NotAllowedError' }));
        onCameraIssueRef.current?.(buildMediaIssue({ media: 'camera', permState: 'denied' }));
        return;
      }

      try {
        stream = await withPermissionPrompt(() =>
          navigator.mediaDevices.getUserMedia({
            video: cameraProfile(isTeacher).capture,
            audio: false,
          })
        );
      } catch (deviceErr) {
        console.warn('camera unavailable', deviceErr);
        if (!cancelled) {
          setLocalCamStream(null);
          const post = await queryMediaPermission('camera');
          onCameraErrorRef.current?.(cameraErrorMessage(deviceErr));
          onCameraIssueRef.current?.(
            buildMediaIssue({
              media: 'camera',
              err: deviceErr,
              permState: post.state === 'unknown' ? pre.state : post.state,
              secureContext: secure,
              hasMediaDevices: hasDevices,
            })
          );
        }
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      onCameraErrorRef.current?.(null);
      onCameraIssueRef.current?.(null);
      setLocalCamStream(stream);

      // iOS Safari / device switch: if the OS ends the video track on backgrounding
      // or device unplug, re-acquire cleanly once the tab is visible again.
      const vTrack = stream.getVideoTracks()[0];
      if (vTrack) {
        vTrack.addEventListener(
          'ended',
          () => {
            if (cancelled || !camDesiredRef.current) return;
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            if (recoverTimer) window.clearTimeout(recoverTimer);
            recoverTimer = window.setTimeout(() => {
              if (!cancelled && camDesiredRef.current) setCamRecoveryTick((n) => n + 1);
            }, 300);
          },
          { once: true }
        );
      }
    }

    void setupLocal();
    return () => {
      cancelled = true;
      if (recoverTimer) window.clearTimeout(recoverTimer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camDesired, camRetryTick, camRecoveryTick]);

  // Recover ended camera or mic tracks after backgrounding (iOS Safari) or hardware switch.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    let visTimer: number | null = null;
    const checkRecovery = () => {
      if (document.visibilityState === 'hidden') return;
      if (visTimer) window.clearTimeout(visTimer);
      visTimer = window.setTimeout(() => {
        visTimer = null;
        if (document.visibilityState === 'hidden') return;
        if (camDesiredRef.current) {
          const live = localCamRef.current?.getVideoTracks().some((t) => t.readyState === 'live');
          if (!live) setCamRecoveryTick((n) => n + 1);
        }
        if (micDesiredRef.current && !mutedRef.current && localParticipant) {
          const pub = localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
          if (!ownMicCurrent(micTrackRef.current, pub)) {
            setPermTick((n) => n + 1);
          }
        }
      }, 300);
    };
    document.addEventListener('visibilitychange', checkRecovery);
    window.addEventListener('pageshow', checkRecovery);
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    md?.addEventListener?.('devicechange', checkRecovery);
    return () => {
      if (visTimer) window.clearTimeout(visTimer);
      document.removeEventListener('visibilitychange', checkRecovery);
      window.removeEventListener('pageshow', checkRecovery);
      md?.removeEventListener?.('devicechange', checkRecovery);
    };
  }, [localParticipant]);

  const previewTrack =
    localCamStream?.getVideoTracks().find((t) => t.readyState === 'live') ?? null;

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

  // Noise-removal settings: a change republishes the mic with the new chain.
  const [voiceKey, setVoiceKey] = useState(() => currentVoiceKey(isTeacher));
  useEffect(() => onVoiceSettings(() => setVoiceKey(currentVoiceKey(isTeacher))), [isTeacher]);
  const micKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const participant = localParticipant;
    if (!participant) return;
    void permTick; // students: retry when the SFU grant arrives (unmute race) or mic recovers
    void enqueueLocalPublish(async () => {
      if (cancelled) return;
      // Teacher mute is authoritative — never publish audio while mutedByTeacher
      const want = micDesired && !mutedByTeacher;
      // Our track is no longer the live published mic (SFU unpublished it on a
      // grant change, or the device ended it): drop it, publish fresh below.
      if (micTrackRef.current && !ownMicCurrent(micTrackRef.current, participant.getTrackPublication(Track.Source.Microphone)?.track)) {
        const stale = micTrackRef.current;
        micTrackRef.current = null;
        await unpublishThenStop(participant, stale);
        if (cancelled) return;
      }
      if (want && micTrackRef.current && micKeyRef.current !== voiceKey) {
        const old = micTrackRef.current;
        micTrackRef.current = null;
        await unpublishThenStop(participant, old);
        if (cancelled) return;
      }
      if (!want) {
        onMicIssueRef.current?.(null);
        const track = micTrackRef.current;
        micTrackRef.current = null;
        if (track) {
          await unpublishThenStop(participant, track);
        }
        if (cancelled) return;
        // Muted = nothing published and the mic device released. A muted
        // publication (LiveKit mute) would keep the mic device open:
        // on phones that keeps the call audio mode (quiet earpiece playback).
        const stray = participant.getTrackPublication(Track.Source.Microphone)?.track as LocalAudioTrack | undefined;
        if (stray) await unpublishThenStop(participant, stray);
        return;
      }
      // Not granted yet (teacher just unmuted us): wait for the grant
      // (ParticipantPermissionsChanged re-runs this) instead of a 403.
      if (!micTrackRef.current && !micPublishAllowed(participant.permissions)) return;

      if (!micTrackRef.current) {
        // Wait until tab is visible before opening mic on iOS Safari.
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        const secure = typeof window === 'undefined' ? true : window.isSecureContext !== false;
        const hasDevices = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
        const pre = await queryMediaPermission('microphone');
        if (cancelled || mutedByTeacher) return;
        if (!secure || !hasDevices) {
          onMicIssueRef.current?.(
            buildMediaIssue({ media: 'microphone', permState: pre.state, secureContext: secure, hasMediaDevices: hasDevices })
          );
          return;
        }
        if (pre.state === 'denied') {
          onMicIssueRef.current?.(
            buildMediaIssue({ media: 'microphone', permState: 'denied', unmutedPrompt: !isTeacher })
          );
          return;
        }

        try {
          // Cleaned up (noise removal, teacher voice focus) where the device
          // can; otherwise the browser-processed mic. Never fails for that.
          const track = await withPermissionPrompt(() => createVoiceTrack(isTeacher));
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
          micKeyRef.current = voiceKey;
          onMicIssueRef.current?.(null);
          track.mediaStreamTrack?.addEventListener(
            'ended',
            () => {
              if (!cancelled && micDesiredRef.current && !mutedRef.current && typeof document !== 'undefined' && document.visibilityState !== 'hidden') {
                setPermTick((n) => n + 1);
              }
            },
            { once: true }
          );
        } catch (e) {
          console.warn('mic', e);
          if (!cancelled) {
            const post = await queryMediaPermission('microphone');
            onMicIssueRef.current?.(
              buildMediaIssue({
                media: 'microphone',
                err: e,
                permState: post.state === 'unknown' ? pre.state : post.state,
                secureContext: secure,
                hasMediaDevices: hasDevices,
                unmutedPrompt: !isTeacher,
              })
            );
          }
          return;
        }
      }
      if (cancelled) return;
      try {
        // Our own track only (never LiveKit's enable-microphone helper: with no
        // publication it would open a second, untracked mic). A server-side
        // mute (teacher muted, then allowed again) is undone here.
        const mine = micTrackRef.current;
        if (mine?.isMuted) await mine.unmute();
      } catch (e) {
        console.warn('mic unmute', e);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [micDesired, mutedByTeacher, localParticipant, isTeacher, voiceKey, permTick]);

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

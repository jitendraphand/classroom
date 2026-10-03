'use client';

import {
  LiveKitRoom,
  RoomAudioRenderer,
  useTracks,
  VideoTrack,
  useLocalParticipant,
  useRoomContext,
} from '@livekit/components-react';
import '@livekit/components-styles';
import {
  Track,
  LocalVideoTrack,
  createLocalAudioTrack,
  LocalAudioTrack,
  RoomEvent,
  ConnectionState,
  AudioPresets,
  VideoPreset,
  type LocalTrackPublication,
  type Participant,
  type ParticipantTrackPermission,
  type TrackPublication,
} from 'livekit-client';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { useRoomState, type RosterInfo } from '@/hooks/useRoomState';
import { Controls } from './Controls';
import { LocalPreview } from './LocalPreview';
import { ChatView, useChatThread } from './Chat';
import { FloatingPanel, useFloatDrag, readFloatPref, writeFloatPref, type FloatPos } from './FloatingPanel';
import { shareControlsPlacement, showLocalSharePreview } from '@/lib/floatGeometry';
import { ScreenAnnotator, useScreenAnnotate, ANNOTATE_COLORS, type AnnotateMode } from './ScreenAnnotator';
import {
  InlineShareDock,
  TeacherShareHud,
  beginShareControls,
  preopenShareControls,
  type ShareControlSurface,
} from './TeacherShareHud';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageLoading } from '@/components/ui/Skeleton';
import { IconHand, IconScreen, IconUsers, IconVideo } from '@/components/ui/Icons';
import { cn } from '@/lib/cn';
import { MIC_LOCKED_NO_TEACHER } from '@/lib/teacherPresenceLogic';
import { roomFetch, rememberClassroomRole, getClassroomRole, claimTeacherTab } from '@/lib/classroomClient';
import { forwardActivityFrom, setLiveSession } from '@/lib/liveSession';
import {
  cameraProfile,
  SCREEN_SHARE,
  screenShareSimulcastFor,
  STUDENT_CAMERA,
  TEACHER_CAMERA,
} from '@/lib/videoQuality';

type TokenPayload = {
  token: string;
  url: string;
  identity: string;
  canPublishVideo: boolean;
  visibleIdentities: string[];
  mutedByTeacher: boolean;
};

/**
 * Live teacher presence from the LiveKit room (not the DB roster): true while a
 * teacher participant is connected, false when none is, null until this
 * client's own connection is up (so a join does not flash "absent").
 * While this client is itself reconnecting, the last answer is kept.
 */
function useTeacherLive(teacherIdentities: string[]): boolean | null {
  const room = useRoomContext();
  const key = teacherIdentities.join(',');
  const [live, setLive] = useState<boolean | null>(null);
  useEffect(() => {
    if (!room) return;
    const set = new Set(key ? key.split(',') : []);
    const update = () => {
      if (room.state !== ConnectionState.Connected) {
        if (room.state === ConnectionState.Disconnected) setLive(null);
        return;
      }
      setLive(
        Array.from(room.remoteParticipants.values()).some((p) => isTeacherParticipant(p, set))
      );
    };
    update();
    room.on(RoomEvent.ParticipantConnected, update);
    room.on(RoomEvent.ParticipantDisconnected, update);
    room.on(RoomEvent.ConnectionStateChanged, update);
    room.on(RoomEvent.Reconnected, update);
    return () => {
      room.off(RoomEvent.ParticipantConnected, update);
      room.off(RoomEvent.ParticipantDisconnected, update);
      room.off(RoomEvent.ConnectionStateChanged, update);
      room.off(RoomEvent.Reconnected, update);
    };
  }, [room, key]);
  return live;
}

export function isTeacherParticipant(
  p: { metadata?: string; identity: string; name?: string },
  teacherIdentities: Set<string>
) {
  if (teacherIdentities.has(p.identity)) return true;
  if (p.identity.startsWith('teacher_')) return true;
  if (p.identity.startsWith('student_')) return false;
  try {
    const meta = p.metadata ? JSON.parse(p.metadata) : {};
    if (meta.role === 'TEACHER') return true;
  } catch {
    /* ignore */
  }
  return false;
}

function ParticipantGrid({
  isTeacher,
  localPreview,
  teacherIdentities,
  visibleIdentities: _visibleIdentities,
  annotate,
  annotateOn,
  annotateMode,
  annotateColor,
  localShareSurface = '',
  onStopShare,
}: {
  /** What this teacher tab is capturing; decides whether the local share may be previewed. */
  localShareSurface?: string;
  onStopShare?: () => void;
  visibleIdentities: string[];
  isTeacher: boolean;
  localPreview: ReactNode;
  teacherIdentities: string[];
  annotate?: ReturnType<typeof useScreenAnnotate>;
  annotateOn?: boolean;
  annotateMode?: AnnotateMode;
  annotateColor?: string;
}) {
  void _visibleIdentities;
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: false },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: true }
  );

  const teacherSet = new Set(teacherIdentities);

  const screenShares = tracks.filter((t) => {
    if (t.source !== Track.Source.ScreenShare) return false;
    // Only the teacher shares a screen (students have no screen-share grant);
    // never render a share from anyone else.
    if (t.participant.isLocal) return isTeacher;
    return isTeacherParticipant(t.participant, teacherSet);
  });

  const cameras = tracks.filter((t) => {
    if (t.source !== Track.Source.Camera || t.participant.isLocal) return false;
    // Only teacher remote videos. Students never see other students; the
    // teacher sees student cameras once, in the docked Class panel
    // (TeacherPeersFloat, with the 2/4/6 mosaic), not again on the stage.
    return isTeacherParticipant(t.participant, teacherSet);
  });

  const hasScreen = screenShares.length > 0;

  if (!hasScreen && cameras.length === 0) {
    return (
      <div className="flex min-h-0 flex-col gap-3">
        <EmptyState
          icon={<IconVideo size={28} />}
          title="Waiting for live video"
          description={
            isTeacher
              ? 'Student cameras are in the Class panel. Share your screen to fill this stage.'
              : 'When your teacher shares a camera or screen, it will appear here.'
          }
          className="min-h-[28vh]"
        />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          <div>{localPreview}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {hasScreen && (
        <div
          className={cn(
            'stage-primary grid min-h-0 flex-1 gap-0 sm:gap-3',
            screenShares.length > 1 ? 'lg:grid-cols-2' : 'grid-cols-1',
            'h-full'
          )}
        >
          {screenShares.map((t) =>
            t.participant.isLocal && !showLocalSharePreview(localShareSurface) ? (
              <EntireScreenShareCard key={`${t.participant.identity}-${t.source}`} onStop={onStopShare} />
            ) : (
            <TeacherShareTile
              key={`${t.participant.identity}-${t.source}`}
              trackRef={t}
              canAnnotate={!!isTeacher && !!t.participant.isLocal && !!annotate}
              annotate={annotate}
              annotateOn={!!annotateOn}
              annotateMode={annotateMode || 'pen'}
              annotateColor={annotateColor || ANNOTATE_COLORS[0]}
            />
            )
          )}
        </div>
      )}

      {/* While the teacher shares, the teacher's own tile lives only in the
          docked Class panel (TeacherPeersFloat); a second copy here would
          squeeze under the dock. */}
      {!(isTeacher && hasScreen) && (
      <div
        className={cn(
          'stage-strip grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4',
          hasScreen && 'max-h-[28vh]'
        )}
      >
        {cameras.map((t) => {
          const speaking = t.participant.isSpeaking;
          const showSampleChip = isTeacher && !isTeacherParticipant(t.participant, teacherSet);
          return (
            <div
              key={`${t.participant.identity}-${t.source}`}
              className={cn(
                'video-tile aspect-video',
                hasScreen && 'max-h-36',
                speaking && 'video-tile-speaking'
              )}
            >
              {t.publication?.track ? (
                <VideoTrack trackRef={t} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full items-center justify-center bg-gradient-to-br from-surface-3 to-ink-950">
                  <Avatar name={t.participant.name || t.participant.identity} size="lg" />
                </div>
              )}
              <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-1 bg-gradient-to-t from-black/70 to-transparent p-2.5">
                <span className="truncate text-xs font-medium">
                  {t.participant.name || t.participant.identity}
                </span>
                {showSampleChip && <span className="chip-sample shrink-0">In sample</span>}
              </div>
            </div>
          );
        })}
        <div className={hasScreen ? 'max-h-36' : undefined}>{localPreview}</div>
      </div>
      )}
    </div>
  );
}


/**
 * Teacher's own stage during an entire-screen (or unknown-surface) share.
 * Playing the local capture here would be captured again, recursively (the
 * "infinite tunnel"), so the teacher gets a static card instead. Students,
 * admin tiles and the observer render the remote track and are unaffected.
 */
function EntireScreenShareCard({ onStop }: { onStop?: () => void }) {
  return (
    <div className="video-tile relative flex h-full min-h-0 w-full items-center justify-center overflow-hidden bg-ink-950 p-4">
      <div className="max-w-md rounded-2xl border border-white/10 bg-surface-1/90 p-5 text-center shadow-lift">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-brand-500/20 text-brand-300">
          <IconScreen size={20} />
        </div>
        <p className="font-display text-base font-semibold">You&apos;re sharing your entire screen</p>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
          Students see your screen live. The preview is hidden here so it is not captured again
          (an endless tunnel). Minimise this window or switch to what you want to show. Share a
          window or a tab instead to see a live preview and draw on it.
        </p>
        {onStop && (
          <Button className="mt-4" variant="danger" size="sm" onClick={onStop}>
            <IconScreen size={14} />
            Stop sharing
          </Button>
        )}
      </div>
    </div>
  );
}

function TeacherShareTile({
  trackRef,
  canAnnotate,
  annotate,
  annotateOn,
  annotateMode,
  annotateColor,
}: {
  trackRef: ReturnType<typeof useTracks>[number];
  canAnnotate: boolean;
  annotate?: ReturnType<typeof useScreenAnnotate>;
  annotateOn: boolean;
  annotateMode: AnnotateMode;
  annotateColor: string;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const t = trackRef;
  const draw = canAnnotate && annotateOn && !!annotate;

  return (
    <div className="video-tile relative min-h-0 h-full w-full overflow-hidden bg-black">
      <div ref={frameRef} className="relative h-full w-full">
        {t.publication?.track ? (
          <VideoTrack trackRef={t} className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full items-center justify-center bg-ink-900 text-slate-400">
            No screen
          </div>
        )}
        {canAnnotate && annotate && (
          <ScreenAnnotator
            frameRef={frameRef}
            strokes={annotate.strokes}
            canDraw={draw}
            tool={annotateMode}
            color={annotateColor}
            onBegin={(p) =>
              annotate.begin(p, annotateMode === 'eraser' ? 'pen' : annotateMode, annotateColor)
            }
            onExtend={annotate.extend}
            onEnd={annotate.end}
            onErase={annotate.eraseAt}
          />
        )}
      </div>
      <div className="pointer-events-none absolute bottom-2 left-2 z-20 flex items-center gap-2 rounded-lg bg-black/65 px-2.5 py-1 text-xs backdrop-blur">
        <Avatar
          name={t.participant.name || t.participant.identity}
          size="sm"
          className="!h-5 !w-5 !text-[9px]"
        />
        <span>
          {t.participant.name || t.participant.identity}
          {' · screen'}
          {t.participant.isLocal ? ' (you)' : ''}
          {draw ? ' · drawing' : ''}
        </span>
      </div>
    </div>
  );
}

export function TeacherScreenStage({
  teacherIdentities,
  code,
  active,
}: {
  teacherIdentities: string[];
  code: string;
  active: boolean;
}) {
  const tracks = useTracks(
    [{ source: Track.Source.ScreenShare, withPlaceholder: false }],
    { onlySubscribed: true }
  );
  const teacherSet = new Set(teacherIdentities);
  const screens = tracks.filter((t) => {
    if (t.source !== Track.Source.ScreenShare) return false;
    if (t.participant.isLocal) return false;
    return isTeacherParticipant(t.participant, teacherSet);
  });

  // Students render the teacher's annotation layer read-only over the share.
  const annotate = useScreenAnnotate({ code, active, canDraw: false });
  const frameRef = useRef<HTMLDivElement | null>(null);

  if (screens.length === 0) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-ink-950 text-slate-400">
        <IconScreen size={32} />
        <p className="text-sm">Waiting for teacher screen…</p>
      </div>
    );
  }

  // Only the last screen share is annotated; the overlay tracks that frame.
  const primary = screens[screens.length - 1];

  return (
    <div className="relative h-full w-full bg-black">
      {screens.map((t) => (
        <div key={`${t.participant.identity}-${t.source}`} className="absolute inset-0">
          <div className="relative h-full w-full">
            <div ref={t === primary ? frameRef : undefined} className="relative h-full w-full">
              {t.publication?.track ? (
                <VideoTrack trackRef={t} className="h-full w-full object-contain" />
              ) : (
                <div className="flex h-full items-center justify-center text-slate-400">No screen</div>
              )}
              {t === primary && (
                <ScreenAnnotator frameRef={frameRef} strokes={annotate.strokes} />
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}


/**
 * One student tile as it appears today: the 16:9 video area of the students
 * float at its single-tile width (~372px pane → ~354×199 content).
 * 2 and 4 are one column (2 or 4 rows). 6 is two columns × 3 rows.
 * The window grows with that grid and only shrinks a tile when the stack would leave the screen.
 */
const PEER_TILE_W = 354;
const PEER_TILE_H = 199;
/** True when the browser exposes getDisplayMedia (required for screen share). */
function canShareScreen(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === 'function'
  );
}

/** Human-readable reason when screen share fails or is unavailable. */
function screenShareErrorMessage(err: unknown): string {
  if (!canShareScreen()) {
    return 'This browser cannot share a screen. iPhone, iPad, and Android browsers do not support screen capture. Use a computer, or the Classroom Android app.';
  }
  const name =
    err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  const msg = err instanceof Error ? err.message : String(err || '');
  if (name === 'NotAllowedError' || /permission|denied|not allowed/i.test(msg)) {
    return 'Screen share was blocked or cancelled. Allow screen sharing when prompted, then try again.';
  }
  if (name === 'NotSupportedError' || /not supported|getDisplayMedia/i.test(msg)) {
    return 'Screen share is not supported in this browser. Use desktop Chrome, Edge, or Firefox, or the Classroom Android app.';
  }
  if (name === 'AbortError' || /abort|cancel/i.test(msg)) {
    return 'Screen share was cancelled.';
  }
  if (name === 'NotFoundError') {
    return 'No screen was selected.';
  }
  if (name === 'SecurityError' || (typeof window !== 'undefined' && window.isSecureContext === false)) {
    return 'Screen share needs a secure https page. Open the class from the https address.';
  }
  return 'Could not start screen share. Try again, or use desktop Chrome, Edge, Firefox, or Safari.';
}

/** 'monitor' | 'window' | 'browser' | '' (browser does not report it). */
function displaySurfaceOf(track: MediaStreamTrack | null | undefined): string {
  if (!track) return '';
  try {
    return String((track.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface ?? '');
  } catch {
    return '';
  }
}

const MONITOR_SHARE_HINT =
  'You are sharing your entire screen, so the controls stay in this tab (a floating window would be captured and seen by students). Share a window or a tab instead to get floating controls.';

function isSharePermissionError(err: unknown): boolean {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  return name === 'NotAllowedError' || name === 'AbortError';
}

/**
 * Start the capture prompt. Called synchronously from the click, before any
 * await, so the browser still treats it as a user gesture. Rich hints are
 * attempted first; permission errors are not retried. Safari skips resolution
 * constraints because specifying them captures a tiny frame.
 */
function captureScreen(): Promise<MediaStream> {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const safari = /safari/i.test(ua) && !/chrome|chromium|crios|edg|android|fxios/i.test(ua);
  const bare = () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  if (safari) return bare();

  const withHints = {
    video: SCREEN_SHARE.capture,
    audio: false as const,
    // The classroom tab is never offered: sharing it would mirror the page
    // (and any in-page share controls) back to the students.
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    systemAudio: 'exclude',
    monitorTypeSurfaces: 'include',
  };

  try {
    const attempt = navigator.mediaDevices.getDisplayMedia(
      withHints as DisplayMediaStreamOptions
    );
    return attempt.catch((err: unknown) => {
      if (isSharePermissionError(err)) throw err;
      return bare();
    });
  } catch (err) {
    if (isSharePermissionError(err)) return Promise.reject(err);
    return bare();
  }
}


const PEER_TOP_RESERVE = 152;
/** Gap between the docked Class panel and the stage edges. */
const PEER_DOCK_MARGIN = 8;
/**
 * Below this stage width the expanded Class panel docks as a top band (stage
 * below it) instead of a left column, and is limited to about half the stage
 * height, so a phone-width stage keeps usable room.
 */
const PEER_DOCK_NARROW_W = 640;
const PEER_DOCK_NARROW_MAX_H = 0.5;
/** Wide stages: the expanded column never takes more than this share of the stage width. */
const PEER_DOCK_MAX_W = 0.45;
/** Above the teacher dock. The share bar is no longer in this page. */
const PEER_BOTTOM_RESERVE = 120;

function peerFloatLayout(
  slots: 2 | 4 | 6,
  vw: number,
  vh: number,
  availH?: number,
  availW?: number
) {
  const cols = slots === 6 ? 2 : 1;
  const rows = slots === 2 ? 2 : slots === 4 ? 4 : 3;
  const header = 34;
  const pad = 16;
  const gap = 6;
  const border = 2;
  const bottomReserve = PEER_BOTTOM_RESERVE;
  const maxPaneW = availW !== undefined ? Math.max(200, availW) : Math.max(200, vw - 16);
  const maxPaneH =
    availH !== undefined ? Math.max(180, availH) : Math.max(180, vh - PEER_TOP_RESERVE - bottomReserve);
  const scale = Math.min(
    1,
    (maxPaneW - pad - border - gap * (cols - 1)) / (PEER_TILE_W * cols),
    (maxPaneH - header - pad - gap * (rows - 1)) / (PEER_TILE_H * rows)
  );
  const tileW = Math.max(112, Math.floor(PEER_TILE_W * scale));
  const tileH = Math.max(63, Math.floor((tileW * 9) / 16));
  const paneW = border + pad + cols * tileW + gap * (cols - 1);
  const paneH = header + pad + rows * tileH + gap * (rows - 1);
  return { cols, rows, tileW, tileH, paneW, paneH, gap };
}


function TeacherCameraFloat({
  teacherIdentities,
  roomCode,
  selfName,
  selfStream,
  camOn,
}: {
  teacherIdentities: string[];
  roomCode: string;
  selfName: string;
  selfStream: MediaStream | null;
  camOn: boolean;
}) {
  const room = useRoomContext();
  const teacherSet = new Set(teacherIdentities);
  const [tick, setTick] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const selfVideoRef = useRef<HTMLVideoElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  type SelfMode = 'show' | 'min' | 'off';
  const selfKey = `student_self_${roomCode.toUpperCase()}`;
  const paneKey = `student_media_min_${roomCode.toUpperCase()}`;
  const [selfMode, setSelfMode] = useState<SelfMode>(() => {
    try {
      const v = sessionStorage.getItem(selfKey);
      if (v === 'show' || v === 'min' || v === 'off') return v;
    } catch {
      /* ignore */
    }
    return 'show';
  });
  const [paneMin, setPaneMin] = useState(() => {
    try {
      return sessionStorage.getItem(paneKey) === '1';
    } catch {
      return false;
    }
  });

  // Bottom-right by default (clamped above the control bar by the hook).
  const defaultPos = useCallback(
    (): FloatPos => ({ x: window.innerWidth - 372, y: window.innerHeight - 200 }),
    []
  );
  const { pos, handleProps } = useFloatDrag({ id: 'student_videos', paneRef, defaultPos });

  useEffect(() => {
    try {
      sessionStorage.setItem(selfKey, selfMode);
    } catch {
      /* ignore */
    }
  }, [selfKey, selfMode]);

  useEffect(() => {
    try {
      sessionStorage.setItem(paneKey, paneMin ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [paneKey, paneMin]);

  useEffect(() => {
    if (!room) return;
    const bump = () => setTick((n) => n + 1);
    const ensure = () => {
      for (const p of Array.from(room.remoteParticipants.values())) {
        if (!isTeacherParticipant(p, teacherSet)) continue;
        const pub = p.getTrackPublication(Track.Source.Camera);
        if (pub && !pub.isSubscribed) {
          try {
            pub.setSubscribed(true);
          } catch (e) {
            console.warn('subscribe teacher cam', e);
          }
        }
      }
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
    const iv = window.setInterval(ensure, 1500);
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
  }, [room, teacherIdentities]);

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

  const mediaTrack = teacherPub?.track?.mediaStreamTrack ?? null;

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
  }, [mediaTrack, paneMin]);

  const hasVideo = !!mediaTrack && !teacherPub?.isMuted;

  useEffect(() => {
    const el = selfVideoRef.current;
    if (!el) return;
    const track = selfStream?.getVideoTracks().find((t) => t.readyState === 'live') ?? null;
    if (!track || selfMode !== 'show' || paneMin) {
      el.srcObject = null;
      return;
    }
    el.srcObject = new MediaStream([track]);
    void el.play().catch(() => {});
    return () => {
      el.srcObject = null;
    };
  }, [selfStream, selfMode, paneMin, camOn]);

  const style = pos ? { left: pos.x, top: pos.y } : { right: 12, bottom: 88 };
  const showSelfTile = selfMode === 'show';

  return (
    <div
      ref={paneRef}
      className="student-media-float"
      data-minimized={paneMin ? '1' : '0'}
      style={style}
      aria-label="Videos — drag the top bar to move"
    >
      {paneMin ? (
        <div className="student-media-restore" {...handleProps} title="Drag to move">
          <span>Videos</span>
          <button type="button" className="student-media-btn" onClick={() => setPaneMin(false)}>
            Show videos
          </button>
        </div>
      ) : (
        <>
          <div className="student-media-head" {...handleProps} title="Drag to move">
            <span className="student-media-title">
              <span aria-hidden className="mr-1 text-white/40">⠿</span>Videos
            </span>
            <span className="flex items-center gap-1">
              {selfMode === 'off' && (
                <button type="button" className="student-media-btn" onClick={() => setSelfMode('show')}>
                  Show me
                </button>
              )}
              <button type="button" className="student-media-btn" onClick={() => setPaneMin(true)}>
                Minimize
              </button>
            </span>
          </div>
          <div className="student-media-row">
            {hasVideo && (
              <div className="student-media-tile" aria-label="Teacher camera">
                <video
                  ref={videoRef}
                  className="pointer-events-none h-full w-full object-cover"
                  autoPlay
                  playsInline
                  muted
                />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-2 pb-1 pt-4">
                  <span className="text-2xs font-semibold tracking-wide text-white">{teacherName}</span>
                </div>
              </div>
            )}
            {showSelfTile && (
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
                  <div className="flex h-full items-center justify-center px-2 text-center text-[10px] text-slate-300">
                    Camera off
                  </div>
                )}
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/75 to-transparent px-1.5 pb-1 pt-4">
                  <span className="pointer-events-none truncate text-2xs font-semibold text-white">
                    {selfName || 'Me'}
                  </span>
                  <span className="flex gap-1">
                    <button type="button" className="student-media-btn" onClick={() => setSelfMode('min')}>
                      Min
                    </button>
                    <button type="button" className="student-media-btn" onClick={() => setSelfMode('off')}>
                      Hide
                    </button>
                  </span>
                </div>
              </div>
            )}
            {selfMode === 'min' && (
              <button type="button" className="student-media-me" onClick={() => setSelfMode('show')}>
                Me
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function TeacherPeersFloat({
  roomCode,
  teacherIdentities,
  visibleIdentities,
  selfName,
  selfStream,
  onSlotsChange,
  dock = null,
  sharing = false,
  onDockSpace,
}: {
  roomCode: string;
  teacherIdentities: string[];
  visibleIdentities: string[];
  selfName: string;
  selfStream: MediaStream | null;
  /** Student-camera count that fills this window (tiles minus the teacher). */
  onSlotsChange?: (studentSlots: number) => void;
  /**
   * Stage rectangle (viewport px). The panel docks to the stage's top-left
   * corner (no dragging) and reports the room it needs via onDockSpace so the
   * stage makes space instead of being covered: a top band when minimized, a
   * left column when expanded (a top band on narrow stages). While sharing it
   * starts minimized each share; otherwise the teacher's saved choice holds.
   */
  dock?: { top: number; left: number; width: number; height: number } | null;
  /** Teacher is screen sharing: the docked panel starts minimized each share. */
  sharing?: boolean;
  onDockSpace?: (space: { left: number; top: number }) => void;
}) {
  const room = useRoomContext();
  const teacherSet = new Set(teacherIdentities);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const sizeRef = useRef({ w: 372, h: 250 });
  const stickySpeakersRef = useRef<Set<string>>(new Set());
  const mosaicPoolRef = useRef<string[]>([]);
  const lastRotationTickRef = useRef(0);
  const [slotCount, setSlotCount] = useState<2 | 4 | 6>(() => {
    try {
      const v = sessionStorage.getItem(`peers_slots_${roomCode.toUpperCase()}`);
      if (v === '2' || v === '4' || v === '6') return Number(v) as 2 | 4 | 6;
    } catch {
      /* ignore */
    }
    return 4;
  });
  const [minimized, setMinimized] = useState(() => {
    try {
      return sessionStorage.getItem(`peers_min_${roomCode.toUpperCase()}`) === '1';
    } catch {
      return false;
    }
  });
  // Docked in the stage corner by default (the stage reserves its space).
  // Dragging the header floats it anywhere; Dock / double-click re-docks.
  const [floating, setFloating] = useState(() => readFloatPref('class_panel.floating') === '1');
  useEffect(() => {
    writeFloatPref('class_panel.floating', floating ? '1' : '0');
  }, [floating]);
  const docked = !!dock && !floating;
  const sharingDock = docked && sharing;
  // Minimized state during a share. Starts collapsed at every share; the
  // teacher's saved (non-share) minimized preference is untouched.
  const [shareMinimized, setShareMinimized] = useState(true);
  useEffect(() => {
    if (sharingDock) setShareMinimized(true);
  }, [sharingDock]);
  const isMin = sharingDock ? shareMinimized : minimized;
  const narrowDock = !!dock && dock.width < PEER_DOCK_NARROW_W;
  const [rotationTick, setRotationTick] = useState(0);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [stickyVersion, setStickyVersion] = useState(0);
  const [tick, setTick] = useState(0);
  const [viewport, setViewport] = useState({ w: 1400, h: 900 });

  const dockAvailH = dock
    ? Math.max(0, (narrowDock ? dock.height * PEER_DOCK_NARROW_MAX_H : dock.height) - 2 * PEER_DOCK_MARGIN)
    : undefined;
  const dockAvailW = dock
    ? Math.max(0, (narrowDock ? dock.width : dock.width * PEER_DOCK_MAX_W) - 2 * PEER_DOCK_MARGIN)
    : undefined;
  const layout = useMemo(
    () => peerFloatLayout(slotCount, viewport.w, viewport.h, dockAvailH, dockAvailW),
    [slotCount, viewport.w, viewport.h, dockAvailH, dockAvailW]
  );
  sizeRef.current = isMin
    ? { w: 168, h: 36 }
    : { w: layout.paneW, h: layout.paneH };

  const defaultPos = useCallback((): FloatPos => {
    const h = sizeRef.current.h;
    return { x: 12, y: Math.max(PEER_TOP_RESERVE, window.innerHeight - h - PEER_BOTTOM_RESERVE) };
  }, []);

  const { pos, reclamp, moveTo, handleProps } = useFloatDrag({
    id: 'class_panel',
    paneRef,
    defaultPos,
    // Dragging the docked panel pulls it out to float (the hook starts the
    // drag from where it is drawn, so it does not jump).
    onDragStart: () => setFloating(true),
  });
  const dock_ = useCallback(() => setFloating(false), []);
  const undock = useCallback(() => {
    const r = paneRef.current?.getBoundingClientRect();
    if (r) moveTo({ x: r.left + 24, y: r.top + 24 });
    setFloating(true);
  }, [moveTo]);

  useEffect(() => {
    try {
      sessionStorage.setItem(`peers_slots_${roomCode.toUpperCase()}`, String(slotCount));
    } catch {
      /* ignore */
    }
  }, [slotCount, roomCode]);

  useEffect(() => {
    try {
      sessionStorage.setItem(`peers_min_${roomCode.toUpperCase()}`, minimized ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [minimized, roomCode]);

  useEffect(() => {
    const read = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, []);

  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const sync = () => {
      const w = el.offsetWidth || layout.paneW;
      const h = el.offsetHeight || (isMin ? 36 : layout.paneH);
      sizeRef.current = { w, h };
      if (docked) {
        // Expanded: a left column (top band when narrow). Minimized: a thin
        // top band for the pill.
        onDockSpace?.(
          isMin || narrowDock
            ? { left: 0, top: h + 2 * PEER_DOCK_MARGIN }
            : { left: w + 2 * PEER_DOCK_MARGIN, top: 0 }
        );
      } else {
        reclamp();
      }
    };
    sync();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [layout.paneW, layout.paneH, isMin, docked, narrowDock, reclamp, onDockSpace]);

  useEffect(() => {
    if (!docked) onDockSpace?.({ left: 0, top: 0 });
  }, [docked, onDockSpace]);

  // Random mosaic rotation ~8s among non-sticky students
  useEffect(() => {
    const iv = window.setInterval(() => setRotationTick((n) => n + 1), 8000);
    return () => window.clearInterval(iv);
  }, []);

  const isMicMuted = useCallback((p: Participant) => {
    try {
      if (!p.isMicrophoneEnabled) return true;
      const pub = p.getTrackPublication(Track.Source.Microphone);
      if (!pub) return true;
      if (pub.isMuted) return true;
      return false;
    } catch {
      return true;
    }
  }, []);

  useEffect(() => {
    if (!room) return;
    const onSpeakers = (speakers: Participant[]) => {
      const sticky = stickySpeakersRef.current;
      let changed = false;
      let topSpeaking: string | null = null;

      for (const s of speakers) {
        if (s.isLocal) continue;
        if (isTeacherParticipant(s, teacherSet)) continue;
        if (isMicMuted(s)) {
          if (sticky.delete(s.identity)) changed = true;
          continue;
        }
        // Unmuted + speaking → sticky until muted
        if (!sticky.has(s.identity)) {
          sticky.add(s.identity);
          changed = true;
        }
        if (!topSpeaking) topSpeaking = s.identity;
      }

      // Drop sticky entries that left or are now muted
      if (room) {
        for (const id of Array.from(sticky)) {
          const p = room.remoteParticipants.get(id);
          if (!p || isMicMuted(p)) {
            sticky.delete(id);
            changed = true;
          }
        }
      }

      setSpeakingId(topSpeaking);
      if (changed) setStickyVersion((n) => n + 1);
    };
    room.on(RoomEvent.ActiveSpeakersChanged, onSpeakers);
    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, onSpeakers);
    };
  }, [room, teacherIdentities, isMicMuted]);

  // Ensure peer cameras in sample are subscribed
  useEffect(() => {
    if (!room) return;
    const ensure = () => {
      for (const p of Array.from(room.remoteParticipants.values())) {
        if (isTeacherParticipant(p, teacherSet)) continue;
        const pub = p.getTrackPublication(Track.Source.Camera);
        if (pub && !pub.isSubscribed) {
          try {
            pub.setSubscribed(true);
          } catch (e) {
            console.warn('subscribe peer cam', e);
          }
        }
        // Keep sticky set in sync with mute state even without speak events
        if (stickySpeakersRef.current.has(p.identity) && isMicMuted(p)) {
          stickySpeakersRef.current.delete(p.identity);
          setStickyVersion((n) => n + 1);
        }
      }
      setTick((n) => n + 1);
    };
    ensure();
    room.on(RoomEvent.TrackPublished, ensure);
    room.on(RoomEvent.TrackSubscribed, ensure);
    room.on(RoomEvent.ParticipantConnected, ensure);
    room.on(RoomEvent.ParticipantDisconnected, ensure);
    room.on(RoomEvent.TrackMuted, ensure);
    room.on(RoomEvent.TrackUnmuted, ensure);
    const iv = window.setInterval(ensure, 2000);
    return () => {
      room.off(RoomEvent.TrackPublished, ensure);
      room.off(RoomEvent.TrackSubscribed, ensure);
      room.off(RoomEvent.ParticipantConnected, ensure);
      room.off(RoomEvent.ParticipantDisconnected, ensure);
      room.off(RoomEvent.TrackMuted, ensure);
      room.off(RoomEvent.TrackUnmuted, ensure);
      window.clearInterval(iv);
    };
  }, [room, teacherIdentities, visibleIdentities, isMicMuted]);

  void tick;
  void stickyVersion;

  const peerIds = useMemo(() => {
    const tSet = new Set(teacherIdentities);
    const hasLiveCamera = (id: string) => {
      if (!room) return false;
      const p = room.remoteParticipants.get(id);
      if (!p || isTeacherParticipant(p, tSet)) return false;
      const pub = p.getTrackPublication(Track.Source.Camera);
      if (!pub || pub.isMuted) return false;
      const media = pub.track?.mediaStreamTrack;
      return !!media && media.readyState !== 'ended';
    };
    // Only cameras actually publishing in the sample. Everyone else stays a blank slot.
    const pool = visibleIdentities.filter(
      (id) => !tSet.has(id) && !id.startsWith('teacher_') && hasLiveCamera(id)
    );
    const sticky = Array.from(stickySpeakersRef.current).filter((id) => pool.includes(id));

    // Speak-reserved slot first (active unmuted speaker), then other stickies
    const slots: string[] = [];
    if (speakingId && pool.includes(speakingId) && !slots.includes(speakingId)) {
      slots.push(speakingId);
    }
    const studentSlotsForSticky = Math.max(0, slotCount - 1);
    for (const id of sticky) {
      if (slots.length >= studentSlotsForSticky) break;
      if (!slots.includes(id)) slots.push(id);
    }

    // First tile is the teacher. Remaining tiles cycle every rotation tick.
    const studentSlots = Math.max(0, slotCount - 1);
    const rest = pool.filter((id) => !slots.includes(id) && !sticky.includes(id));
    const prevMosaic = mosaicPoolRef.current.filter((id) => rest.includes(id));
    const needSlots = Math.max(0, studentSlots - slots.length);
    const membershipChanged =
      prevMosaic.length !== rest.length || prevMosaic.some((id) => !rest.includes(id));
    let mosaic = prevMosaic;
    if (membershipChanged || mosaic.length === 0 || mosaic.length < Math.min(rest.length, needSlots)) {
      const shuffled = [...rest];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      mosaic = shuffled;
      mosaicPoolRef.current = mosaic;
    }
    if (lastRotationTickRef.current !== rotationTick) {
      lastRotationTickRef.current = rotationTick;
      const rotating = mosaic.filter((id) => rest.includes(id));
      for (const id of rest) {
        if (!rotating.includes(id)) rotating.push(id);
      }
      mosaic = rotating.length > 1 ? [...rotating.slice(1), rotating[0]] : rotating;
      mosaicPoolRef.current = mosaic;
    }

    for (const id of mosaic) {
      if (slots.length >= studentSlots) break;
      slots.push(id);
    }
    // Never backfill with students who are not publishing a sample camera.
    // The grid still paints `slotCount` cells; the rest stay blank.
    return slots.slice(0, Math.max(0, slotCount - 1));
  }, [
    visibleIdentities,
    teacherIdentities,
    room,
    speakingId,
    rotationTick,
    slotCount,
    tick,
    stickyVersion,
  ]);

  const cells: Array<string | null> = ['__self__'];
  for (let i = 0; i < slotCount - 1; i++) cells.push(peerIds[i] ?? null);

  const style: CSSProperties = docked && dock
    ? { left: dock.left + PEER_DOCK_MARGIN, top: dock.top + PEER_DOCK_MARGIN }
    : pos
      ? { left: pos.x, top: pos.y }
      : { left: 12, top: PEER_TOP_RESERVE };
  if (!isMin) {
    // Size is the selected slot layout, even when some tiles are blank.
    style.width = layout.paneW;
    style.height = layout.paneH;
  }

  return (
    <div
      ref={paneRef}
      className="peers-float-pane"
      role="region"
      data-slots={slotCount}
      data-minimized={isMin ? '1' : '0'}
      data-docked={docked ? '1' : '0'}
      style={style}
      aria-label="Class videos — drag the top bar to move"
    >
      <div
        className="peers-float-header"
        {...handleProps}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          if (floating && dock) dock_();
        }}
        title={docked ? 'Drag to float this panel' : 'Drag to move · double-click to dock'}
      >
        <span className="text-2xs font-semibold text-slate-200">
          <span aria-hidden className="mr-1 text-slate-500">⠿</span>
          Class{isMin ? ` · ${peerIds.length + 1}` : ''}
        </span>
        <div className="flex items-center gap-1" data-no-drag>
          {dock && (
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-[10px] font-bold text-slate-300 hover:bg-white/10"
              onClick={floating ? dock_ : undock}
              aria-label={floating ? 'Dock class videos beside the stage' : 'Float class videos'}
              title={floating ? 'Dock beside the stage' : 'Float (drag anywhere)'}
            >
              {floating ? 'Dock' : 'Float'}
            </button>
          )}
          {!isMin &&
            ([2, 4, 6] as const).map((n) => (
              <button
                key={n}
                type="button"
                className={cn(
                  'rounded px-1.5 py-0.5 text-[10px] font-bold transition',
                  slotCount === n
                    ? 'bg-brand-600 text-white'
                    : 'bg-white/10 text-slate-300 hover:bg-white/20'
                )}
                onClick={() => {
                  setSlotCount(n);
                  onSlotsChange?.(n - 1);
                }}
                aria-label={`Show ${n} videos`}
                title={`Show ${n} videos, including you`}
              >
                {n}
              </button>
            ))}
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] font-bold text-slate-300 hover:bg-white/10"
            onClick={() => (sharingDock ? setShareMinimized((v) => !v) : setMinimized((v) => !v))}
            aria-label={isMin ? 'Expand class videos' : 'Minimize class videos'}
            title={isMin ? 'Expand' : 'Minimize'}
          >
            {isMin ? '▢' : '—'}
          </button>
        </div>
      </div>
      {!isMin && (
        <div
          className="peers-float-grid"
          data-slots={slotCount}
          style={{
            gridTemplateRows: `repeat(${layout.rows}, ${layout.tileH}px)`,
          }}
        >
          {cells.map((identity, i) => {
            if (identity === '__self__') {
              const selfTrack =
                selfStream
                  ?.getVideoTracks()
                  .find((track) => track.readyState === 'live' && track.enabled) ?? null;
              return (
                <PeerCamTile
                  key="self"
                  name={`${selfName} (you)`}
                  mediaTrack={selfTrack}
                  speaking={false}
                  pinned={false}
                  mirror
                  tileW={layout.tileW}
                  tileH={layout.tileH}
                />
              );
            }
            if (!identity) {
              return (
                <div
                  key={`empty-${i}`}
                  className="peers-float-tile"
                  data-empty="1"
                  style={{
                    width: layout.tileW,
                    height: layout.tileH,
                    display: 'grid',
                    placeItems: 'center',
                    color: '#94a3b8',
                    fontSize: 10,
                    fontWeight: 650,
                  }}
                >
                  Off camera
                </div>
              );
            }
            let name = identity;
            let mediaTrack: MediaStreamTrack | null = null;
            let speaking = false;
            if (room) {
              const p = room.remoteParticipants.get(identity);
              if (p) {
                name = p.name || p.identity;
                speaking = p.isSpeaking || speakingId === identity;
                const pub = p.getTrackPublication(Track.Source.Camera);
                mediaTrack = pub?.track?.mediaStreamTrack ?? null;
              }
            }
            return (
              <PeerCamTile
                key={identity}
                name={name}
                mediaTrack={mediaTrack}
                speaking={speaking}
                pinned={stickySpeakersRef.current.has(identity) || speakingId === identity}
                tileW={layout.tileW}
                tileH={layout.tileH}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function PeerCamTile({
  name,
  mediaTrack,
  speaking,
  pinned,
  tileW,
  tileH,
  mirror = false,
}: {
  name: string;
  mediaTrack: MediaStreamTrack | null;
  speaking: boolean;
  pinned: boolean;
  tileW: number;
  tileH: number;
  mirror?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
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
  }, [mediaTrack]);

  return (
    <div
      className={cn(
        'peers-float-tile',
        speaking && 'ring-2 ring-brand-400'
      )}
      style={{ width: tileW, height: tileH }}
    >
      {mediaTrack ? (
        <video
          ref={videoRef}
          className={cn('h-full w-full object-cover', mirror && 'video-mirror')}
          autoPlay
          playsInline
          muted
        />
      ) : (
        <div className="flex h-full items-center justify-center bg-gradient-to-br from-surface-3 to-ink-950">
          <Avatar name={name} size="sm" />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/75 to-transparent px-1.5 pb-1 pt-4">
        <span className="truncate text-[10px] font-medium text-white">{name}</span>
        {pinned && <span className="shrink-0 text-[9px] text-brand-300">Speaking</span>}
      </div>
    </div>
  );
}

function useHasTeacherScreen(teacherIdentities: string[]) {
  const tracks = useTracks(
    [{ source: Track.Source.ScreenShare, withPlaceholder: false }],
    { onlySubscribed: true }
  );
  const teacherSet = new Set(teacherIdentities);
  return tracks.some((t) => {
    if (t.source !== Track.Source.ScreenShare) return false;
    if (t.participant.isLocal) return false;
    return isTeacherParticipant(t.participant, teacherSet);
  });
}


/** Release a local track. LocalVideoTrack.stop throws if a simulcast MediaStreamTrack is null. */
function safeStop(track: LocalVideoTrack | LocalAudioTrack | null | undefined) {
  if (!track) return;
  if (track instanceof LocalVideoTrack) {
    track.simulcastCodecs.forEach((info) => {
      try {
        const raw = info?.mediaStreamTrack;
        if (raw && raw.readyState !== 'ended') raw.stop();
      } catch {
        /* already stopped */
      }
    });
  }
  try {
    const raw = track.mediaStreamTrack;
    if (raw && raw.readyState !== 'ended') raw.stop();
  } catch {
    /* media track already released */
  }
  try {
    track.stop();
  } catch {
    /* simulcast mediaStreamTrack already null */
  }
}

function simulcastMediaTracks(track: LocalVideoTrack | LocalAudioTrack): MediaStreamTrack[] {
  if (!(track instanceof LocalVideoTrack)) return [];
  const tracks: MediaStreamTrack[] = [];
  track.simulcastCodecs.forEach((info) => {
    if (info?.mediaStreamTrack) tracks.push(info.mediaStreamTrack);
  });
  return tracks;
}

/**
 * Negotiate the unpublish before the media track ends. The default path stops
 * the track first, which throws once a simulcast MediaStreamTrack is null and
 * ends the remote subscription before publication metadata arrives.
 */
async function unpublishThenStop(
  localParticipant: {
    unpublishTrack: (
      track: LocalVideoTrack | LocalAudioTrack,
      stopOnUnpublish?: boolean
    ) => Promise<unknown>;
  },
  track: LocalVideoTrack | LocalAudioTrack
) {
  const simulcast = simulcastMediaTracks(track);
  try {
    await localParticipant.unpublishTrack(track, false);
  } catch {
    /* already unpublished */
  }
  for (const raw of simulcast) {
    try {
      if (raw.readyState !== 'ended') raw.stop();
    } catch {
      /* already stopped */
    }
  }
  safeStop(track);
}

/**
 * One local publish or unpublish at a time. A second offer that starts before
 * the first answer arrives times out; LiveKit then reconnects and unpublishes
 * the screen share, which used to close the teacher's controls.
 */
let localPublishChain: Promise<void> = Promise.resolve();
function enqueueLocalPublish(task: () => Promise<void>): Promise<void> {
  const run = localPublishChain.catch(() => undefined).then(task);
  localPublishChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function screenCaptureLive(pub?: LocalTrackPublication | null): boolean {
  const media = pub?.track?.mediaStreamTrack;
  return !!media && media.readyState !== 'ended';
}

/** Human-readable camera failure. Shown instead of publishing a fake camera. */
function cameraErrorMessage(err: unknown): string {
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
function SelectivePublisher({
  isTeacher,
  canPublishVideo,
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

  useEffect(() => {
    if (!localParticipant || !room) return;
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
        await participant.publishTrack(
          track,
          isTeacher
            ? {
                source: Track.Source.Camera,
                simulcast: TEACHER_CAMERA.simulcast,
                videoEncoding: TEACHER_CAMERA.encoding,
                videoSimulcastLayers: TEACHER_CAMERA.layers.map(
                  (l) => new VideoPreset(l.width, l.height, l.maxBitrate, l.maxFramerate)
                ),
              }
            : {
                source: Track.Source.Camera,
                simulcast: STUDENT_CAMERA.simulcast,
                videoEncoding: STUDENT_CAMERA.encoding,
              }
        );
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
    });
  }, [canPublishVideo, camDesired, previewTrack, localParticipant, room, isTeacher]);

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
          const track = await createLocalAudioTrack();
          if (cancelled || mutedByTeacher) {
            safeStop(track);
            return;
          }
          try {
            await participant.publishTrack(track, {
              source: Track.Source.Microphone,
              audioPreset: AudioPresets.speech,
            });
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
  }, [micDesired, mutedByTeacher, localParticipant]);

  return null;
}

function CameraErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
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

/**
 * Student-side media privacy (H-4).
 *
 * Subscriber side: the student connects with autoSubscribe off and subscribes
 * only to the teacher's tracks (camera, microphone, screen) and to classmates'
 * microphones (class audio is not limited by the sample). Other students'
 * cameras are never subscribed.
 *
 * Publisher side (enforced by the SFU for this student's own tracks): only
 * the teacher may subscribe to everything; classmates may subscribe to the
 * microphone track only. So even a modified classmate client cannot pull this
 * student's camera.
 */
function StudentMediaPrivacy({
  teacherIdentities,
  studentIdentities,
}: {
  teacherIdentities: string[];
  studentIdentities: string[];
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

      for (const p of Array.from(room.remoteParticipants.values())) {
        const isTeacherP = isTeacherParticipant(p, teacherSet);
        if (isTeacherP) teachers.add(p.identity);
        else classmates.add(p.identity);
        for (const pub of Array.from(p.trackPublications.values())) {
          const want = isTeacherP || pub.source === Track.Source.Microphone;
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
      const perms: ParticipantTrackPermission[] = Array.from(teachers)
        .sort()
        .map((identity) => ({ participantIdentity: identity, allowAll: true }));
      if (micSid) {
        for (const identity of Array.from(classmates).sort()) {
          perms.push({ participantIdentity: identity, allowAll: false, allowedTrackSids: [micSid] });
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
    room.on(RoomEvent.LocalTrackPublished, sync);
    room.on(RoomEvent.LocalTrackUnpublished, sync);
    const iv = window.setInterval(sync, 3000);
    return () => {
      room.off(RoomEvent.Connected, resync);
      room.off(RoomEvent.Reconnected, resync);
      room.off(RoomEvent.ParticipantConnected, sync);
      room.off(RoomEvent.ParticipantDisconnected, sync);
      room.off(RoomEvent.TrackPublished, sync);
      room.off(RoomEvent.LocalTrackPublished, sync);
      room.off(RoomEvent.LocalTrackUnpublished, sync);
      window.clearInterval(iv);
    };
  }, [room, teacherKey, studentKey]);

  return null;
}

function RoomInner({
  code,
  isTeacher,
  canPublishVideo,
  mutedByTeacher,
  visibleIdentities,
  displayName,
  onVisibilityChange,
  onClassEnded,
}: {
  code: string;
  isTeacher: boolean;
  canPublishVideo: boolean;
  mutedByTeacher: boolean;
  visibleIdentities: string[];
  displayName: string;
  onVisibilityChange: (v: boolean) => void;
  onClassEnded: () => void;
}) {
  const router = useRouter();
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const [micOn, setMicOn] = useState(true);
  // Teacher camera starts OFF (turned on from the dock). Students keep their
  // previous default. Nothing is captured or published until camOn is true.
  const [camOn, setCamOn] = useState(() => !isTeacher);
  const [inviteCopied, setInviteCopied] = useState<'' | 'link' | 'code'>('');
  const [screenOn, setScreenOn] = useState(false);
  const [chatUnread, setChatUnread] = useState(0);
  const [localCamStream, setLocalCamStream] = useState<MediaStream | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [hudChatOpen, setHudChatOpen] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);
  /** Student left fullscreen (Esc, swipe, app switch): prompt, never kick. */
  const [fsPrompt, setFsPrompt] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  const [hudOpen, setHudOpen] = useState(false);
  const [hudNotice, setHudNotice] = useState('');
  const [annotateOn, setAnnotateOn] = useState(false);
  const [annotateMode, setAnnotateMode] = useState<AnnotateMode>('pen');
  const [annotateColor, setAnnotateColor] = useState(ANNOTATE_COLORS[0]);
  /** True while we intentionally change presentation stage (avoids teardown races). */
  const stageSwitchRef = useRef(false);
  /** Teacher still wants the screen shared across a LiveKit reconnect. */
  const shareWantedRef = useRef(false);
  const shareEndTimer = useRef<number | null>(null);
  const shareWindowRef = useRef<Window | null>(null);
  const shareCloseRef = useRef<(() => void) | null>(null);
  const shareHideCleanup = useRef<(() => void) | null>(null);
  const closingShareRef = useRef(false);
  const shareStartRef = useRef(false);
  const [shareMount, setShareMount] = useState<HTMLElement | null>(null);
  const [shareWindow, setShareWindow] = useState<Window | null>(null);
  /** What the teacher is capturing ('monitor' | 'window' | 'browser' | ''). */
  const [shareSurface, setShareSurface] = useState('');
  const shareSurfaceRef = useRef('');
  const { state, refresh } = useRoomState(code, 2000);
  /** Student-camera cap chosen from the float, shown before the next poll confirms it. */
  const [sampleCap, setSampleCap] = useState<number | null>(null);
  const capQueue = useRef(Promise.resolve());
  const chatStopped = state?.status === 'ENDED' || !!state?.ended;
  const chatActive = (isTeacher ? chatOpen && !screenOn : chatOpen) || hudChatOpen;
  const myParticipantId = state?.me?.id ?? null;
  const chatStudents = (state?.admitted ?? [])
    .filter((a) => a.role === 'STUDENT')
    .map((a) => ({ id: a.id, displayName: a.displayName }));
  const chatThread = useChatThread({
    code,
    isTeacher,
    myParticipantId,
    onUnreadChange: setChatUnread,
    active: chatActive,
    stopped: chatStopped,
  });

  const rawStage = state?.stageMode ?? 'idle';
  // Whiteboard product surface removed — treat legacy redis value as idle.
  const stageMode: 'idle' | 'screen' = rawStage === 'screen' ? 'screen' : 'idle';
  const teacherIdentities = (state?.admitted ?? [])
    .filter((a) => a.role === 'TEACHER')
    .map((a) => a.livekitIdentity);
  const studentIdentities = (state?.admitted ?? [])
    .filter((a) => a.role === 'STUDENT')
    .map((a) => a.livekitIdentity);
  // Fallback: if teacher screen track(s) exist, treat as screen present even if redis idle
  const hasTeacherScreen = useHasTeacherScreen(teacherIdentities);
  const effectiveStage: 'idle' | 'screen' =
    stageMode !== 'idle' ? stageMode : hasTeacherScreen ? 'screen' : 'idle';

  // Teacher draws on the classroom screen-share stage; HUD only holds the tools.
  const screenAnnotateActive =
    isTeacher && (screenOn || stageMode === 'screen' || effectiveStage === 'screen');
  const annotate = useScreenAnnotate({
    code,
    active: screenAnnotateActive,
    canDraw: isTeacher,
  });

  useEffect(() => {
    onVisibilityChange(!!state?.me?.canPublishVideo);
  }, [state?.me?.canPublishVideo, onVisibilityChange]);

  const effectiveCanPublish = state?.me?.canPublishVideo ?? canPublishVideo;
  const effectiveMuted = state?.me?.mutedByTeacher ?? mutedByTeacher;
  // Students are force-muted while the teacher is not connected (enforced by
  // the SFU grant via the LiveKit webhook; this mirrors it in the UI).
  const teacherLive = useTeacherLive(teacherIdentities);
  const micLockedNoTeacher = !isTeacher && teacherLive === false;
  const visibles = state?.visibleIdentities ?? visibleIdentities;

  useEffect(() => {
    if (effectiveMuted) setMicOn(false);
  }, [effectiveMuted]);

  // Teacher away → mic off. It stays off when the teacher returns: the student
  // unmutes themselves (never auto-unmute the class).
  useEffect(() => {
    if (micLockedNoTeacher) setMicOn(false);
  }, [micLockedNoTeacher]);

  useEffect(() => {
    if (state?.status === 'ENDED' || state?.ended) {
      try {
        room?.disconnect();
      } catch {
        /* ignore */
      }
      onClassEnded();
    }
  }, [state?.status, state?.ended, room, onClassEnded]);

  useEffect(() => {
    if (!isTeacher || !room) return;
    const pinnedRecently = new Map<string, number>();
    const studentIdentities = new Set(
      (state?.admitted ?? [])
        .filter((a) => a.role === 'STUDENT')
        .map((a) => a.livekitIdentity)
    );
    const visibleSet = new Set(state?.visibleIdentities ?? visibleIdentities);

    const postPin = (identity: string, pinned: boolean) => {
      // Rate-limit only the pinning direction; releases must always land so a
      // muted student cannot hold a slot.
      if (pinned) {
        const last = pinnedRecently.get(identity) || 0;
        if (Date.now() - last < 2000) return;
      }
      pinnedRecently.set(identity, Date.now());
      void roomFetch(code, '/sample/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity, pinned }),
      }).then((res) => {
        if (res.ok) refresh();
      });
    };

    const onSpeakers = (speakers: Participant[]) => {
      for (const s of speakers) {
        if (s.isLocal) continue;
        if (!studentIdentities.has(s.identity)) continue;
        if (visibleSet.has(s.identity)) continue;
        postPin(s.identity, true);
      }
    };

    // Sticky speak-pins last "until mute". A student who speaks once and then
    // mutes their own microphone must release their reserved slot, otherwise they
    // keep publishing (and holding a slot) for the rest of the class.
    const onTrackMuted = (pub: TrackPublication, participant: Participant) => {
      if (!pub || pub.source !== Track.Source.Microphone) return;
      const identity = participant?.identity;
      if (!identity || !studentIdentities.has(identity)) return;
      postPin(identity, false);
    };

    room.on(RoomEvent.ActiveSpeakersChanged, onSpeakers);
    room.on(RoomEvent.TrackMuted, onTrackMuted);
    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, onSpeakers);
      room.off(RoomEvent.TrackMuted, onTrackMuted);
    };
  }, [isTeacher, room, code, refresh, state?.admitted, state?.visibleIdentities, visibleIdentities]);

  const postStage = useCallback(
    async (mode: 'idle' | 'screen') => {
      if (!isTeacher) return;
      try {
        await roomFetch(code, '/stage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode }),
        });
        refresh();
      } catch (e) {
        console.warn('stage', e);
      }
    },
    [code, isTeacher, refresh]
  );


  // NOTE: `chromeVisible` / `bumpChrome` were removed. The state was only ever
  // ever set to `true` (the auto-hide timer that would have cleared it was
  // dropped), so the opacity branch below was unreachable and the "tap to show
  // controls" behaviour never fired. Controls are always visible on the
  // student stage, which is the intended behaviour.

  // Student fullscreen: request it on join. Leaving fullscreen (Esc, a swipe,
  // a browser prompt) only shows a "Return to full screen" prompt. It never
  // marks the student LEFT or disconnects them; only an explicit Leave (or the
  // connection dropping) does that.
  useEffect(() => {
    if (isTeacher) return;
    const root = document.documentElement;
    let entered = false;
    let cancelled = false;

    const requestFs = async () => {
      if (cancelled || !root.requestFullscreen) return;
      try {
        if (!document.fullscreenElement) {
          await root.requestFullscreen();
        }
        if (document.fullscreenElement) {
          entered = true;
          setFsPrompt(false);
        }
      } catch {
        // Browser blocked / needs gesture / unsupported — carry on windowed.
      }
    };

    void requestFs();

    const onGesture = () => {
      if (!entered && !document.fullscreenElement) void requestFs();
    };

    const onFsChange = () => {
      if (cancelled) return;
      if (document.fullscreenElement) {
        entered = true;
        setFsPrompt(false);
        return;
      }
      if (entered) setFsPrompt(true);
    };

    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('pointerdown', onGesture, { once: true });
    document.addEventListener('keydown', onGesture, { once: true });
    return () => {
      cancelled = true;
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('pointerdown', onGesture);
      document.removeEventListener('keydown', onGesture);
    };
  }, [isTeacher]);

  const returnToFullscreen = useCallback(() => {
    const root = document.documentElement;
    if (!root.requestFullscreen) {
      setFsPrompt(false);
      return;
    }
    root
      .requestFullscreen()
      .then(() => setFsPrompt(false))
      // Could not re-enter (browser policy): do not trap the student behind the prompt.
      .catch(() => setFsPrompt(false));
  }, []);

  // While connected to the LiveKit room, idle logout is suspended (H-2): a
  // teacher presenting elsewhere or a student who is only watching must not
  // be signed out mid-class.
  useEffect(() => {
    if (!room) return;
    const update = () => {
      const st = room.state;
      setLiveSession(
        st === ConnectionState.Connected ||
          st === ConnectionState.Reconnecting ||
          st === ConnectionState.SignalReconnecting
      );
    };
    update();
    room.on(RoomEvent.ConnectionStateChanged, update);
    return () => {
      room.off(RoomEvent.ConnectionStateChanged, update);
      setLiveSession(false);
    };
  }, [room]);

  /**
   * Screen share ended (button, browser "Stop sharing" bar, or track teardown):
   * close the HUD and wipe the annotation layer for everyone. Never touches the
   * LiveKit connection, so students simply fall back to their waiting stage.
   */
  const endShareSession = useCallback(() => {
    shareWantedRef.current = false;
    if (shareEndTimer.current) {
      window.clearTimeout(shareEndTimer.current);
      shareEndTimer.current = null;
    }
    closingShareRef.current = true;
    shareHideCleanup.current?.();
    shareHideCleanup.current = null;
    const close = shareCloseRef.current;
    shareCloseRef.current = null;
    shareWindowRef.current = null;
    try {
      close?.();
    } catch {
      /* ignore */
    }
    closingShareRef.current = false;
    setShareWindow(null);
    setShareMount(null);
    setScreenOn(false);
    setHudOpen(false);
    setHudNotice('');
    setAnnotateOn(false);
    shareSurfaceRef.current = '';
    setShareSurface('');
  }, []);

  const attachShareSurface = useCallback((surface: ShareControlSurface | null) => {
    shareHideCleanup.current?.();
    shareHideCleanup.current = null;
    const prevClose = shareCloseRef.current;
    const prevWin = shareWindowRef.current;
    shareCloseRef.current = null;
    shareWindowRef.current = null;
    if (prevClose && prevWin && (!surface || prevWin !== surface.window)) {
      closingShareRef.current = true;
      try {
        prevClose();
      } catch {
        /* ignore */
      }
      closingShareRef.current = false;
    }
    if (!surface || surface.window.closed) {
      setShareWindow(null);
      setShareMount(null);
      setHudOpen(false);
      return;
    }
    shareWindowRef.current = surface.window;
    shareCloseRef.current = surface.close;
    const onHide = () => {
      // The teacher closed the controls. The share keeps going; the page
      // offers a button to open the window again. Do not dock the bar back.
      if (closingShareRef.current) return;
      shareWindowRef.current = null;
      shareCloseRef.current = null;
      setShareWindow(null);
      setShareMount(null);
      setHudOpen(false);
    };
    surface.window.addEventListener('pagehide', onHide);
    // Clicks and keys in the pop-out / PiP count as activity for idle logout.
    const stopForwarding = forwardActivityFrom(surface.window);
    shareHideCleanup.current = () => {
      stopForwarding();
      try {
        surface.window.removeEventListener('pagehide', onHide);
      } catch {
        /* ignore */
      }
    };
    setShareWindow(surface.window);
    setShareMount(surface.mount);
    setHudOpen(true);
  }, []);

  // The browser's own "Stop sharing" bar ends the capture. A reconnect only
  // unpublishes the same live track and publishes it again — that must not
  // close the controls or tell students the screen is gone.
  useEffect(() => {
    if (!isTeacher || !localParticipant || !room) return;
    let cancelled = false;

    const roomBusy = () =>
      room.state === ConnectionState.Reconnecting ||
      room.state === ConnectionState.SignalReconnecting;

    const confirmShareEnded = () => {
      if (shareEndTimer.current) window.clearTimeout(shareEndTimer.current);
      shareEndTimer.current = window.setTimeout(() => {
        shareEndTimer.current = null;
        if (cancelled || stageSwitchRef.current || !shareWantedRef.current) return;
        const pub = localParticipant.getTrackPublication(Track.Source.ScreenShare);
        if (screenCaptureLive(pub) || roomBusy()) {
          if (roomBusy() || !pub) confirmShareEnded();
          return;
        }
        endShareSession();
        void postStage('idle');
      }, 2000);
    };

    const onUnpublished = (pub: LocalTrackPublication) => {
      if (pub?.source !== Track.Source.ScreenShare) return;
      if (stageSwitchRef.current) return;
      if (screenCaptureLive(pub) || roomBusy()) {
        confirmShareEnded();
        return;
      }
      endShareSession();
      void postStage('idle');
    };

    const onReconnected = () => {
      if (!shareWantedRef.current) return;
      const pub = localParticipant.getTrackPublication(Track.Source.ScreenShare);
      if (!screenCaptureLive(pub)) return;
      if (shareEndTimer.current) {
        window.clearTimeout(shareEndTimer.current);
        shareEndTimer.current = null;
      }
      setScreenOn(true);
      const win = shareWindowRef.current;
      if (win && !win.closed) setHudOpen(true);
      void postStage('screen');
    };

    localParticipant.on(RoomEvent.LocalTrackUnpublished, onUnpublished);
    room.on(RoomEvent.Reconnected, onReconnected);
    return () => {
      cancelled = true;
      if (shareEndTimer.current) window.clearTimeout(shareEndTimer.current);
      localParticipant.off(RoomEvent.LocalTrackUnpublished, onUnpublished);
      room.off(RoomEvent.Reconnected, onReconnected);
    };
  }, [isTeacher, localParticipant, room, postStage, endShareSession]);

  // A teacher who dropped off mid-share (lost internet, closed the tab) could
  // not tell the server the share ended, so Redis still says stage=screen and
  // students sit on "Waiting for teacher screen…" after the teacher reloads.
  // On the first room-state snapshot of a fresh teacher session, clear that
  // stale stage (and its annotations) unless this tab is already sharing.
  const staleStageChecked = useRef(false);
  useEffect(() => {
    if (!isTeacher || !state || staleStageChecked.current) return;
    staleStageChecked.current = true;
    if (state.stageMode !== 'screen') return;
    if (screenOn || shareStartRef.current || shareWantedRef.current) return;
    const pub = localParticipant?.getTrackPublication(Track.Source.ScreenShare);
    if (screenCaptureLive(pub)) return;
    void postStage('idle');
  }, [isTeacher, state, screenOn, localParticipant, postStage]);

  useEffect(() => {
    // LiveKit disconnects on the page "freeze" event even when
    // disconnectOnPageLeave is off. A backgrounded or minimized window must
    // keep the class. Closing the tab still drops the socket.
    const keepAlive = (ev: Event) => {
      ev.stopImmediatePropagation();
    };
    window.addEventListener('freeze', keepAlive, true);
    return () => window.removeEventListener('freeze', keepAlive, true);
  }, []);

  useEffect(() => {
    return () => {
      closingShareRef.current = true;
      shareHideCleanup.current?.();
      try {
        shareCloseRef.current?.();
      } catch {
        /* ignore */
      }
    };
  }, []);

  /** Re-open the controls window. Must run in the click, before any await. */
  const reopenShareControls = useCallback(() => {
    // Never during an entire-screen capture: the window would be recorded.
    if (shareControlsPlacement(shareSurfaceRef.current) === 'inline') {
      setHudNotice(MONITOR_SHARE_HINT);
      return;
    }
    const pending = beginShareControls();
    void pending.then((surface) => {
      if (!shareWantedRef.current || shareControlsPlacement(shareSurfaceRef.current) === 'inline') {
        surface?.close();
        return;
      }
      if (!surface) {
        setHudNotice(
          'The browser blocked the share controls window. Allow pop-ups for this site, or use the controls in this tab.'
        );
        return;
      }
      attachShareSurface(surface);
      setHudNotice('');
    });
  }, [attachShareSurface]);

  // Chrome's "Share this instead" (surfaceSwitching) can move a running share
  // from a window/tab to the entire screen. Watch the live track: once it
  // reports 'monitor', close the floating window (it would now be captured)
  // and fall back to the in-page controls.
  useEffect(() => {
    if (!isTeacher || !screenOn || !localParticipant) return;
    const check = () => {
      const pub = localParticipant.getTrackPublication(Track.Source.ScreenShare);
      const kind = displaySurfaceOf(pub?.track?.mediaStreamTrack);
      if (!kind || kind === shareSurfaceRef.current) return;
      shareSurfaceRef.current = kind;
      setShareSurface(kind);
      if (shareControlsPlacement(kind) === 'inline' && shareWindowRef.current) {
        attachShareSurface(null);
      }
    };
    check();
    const iv = window.setInterval(check, 1500);
    return () => window.clearInterval(iv);
  }, [isTeacher, screenOn, localParticipant, attachShareSurface]);

  /**
   * The click fires getDisplayMedia and the controls window in the same turn,
   * before any await. Awaiting either one first spends the user gesture, and
   * the other call is rejected.
   */
  const toggleScreen = useCallback(async () => {
    if (!localParticipant || !isTeacher) return;
    if (screenOn) {
      shareWantedRef.current = false;
      stageSwitchRef.current = true;
      try {
        await enqueueLocalPublish(async () => {
          try {
            await localParticipant.setScreenShareEnabled(false);
          } catch {
            /* ignore */
          }
        });
      } finally {
        stageSwitchRef.current = false;
      }
      endShareSession();
      await postStage('idle');
      return;
    }

    if (shareStartRef.current) return;

    if (!canShareScreen()) {
      setHudNotice(screenShareErrorMessage(null));
      return;
    }

    shareStartRef.current = true;
    const controlsPromise = beginShareControls();
    const streamPromise = captureScreen();

    let stream: MediaStream;
    try {
      stream = await streamPromise;
    } catch (e) {
      shareStartRef.current = false;
      const controls = await controlsPromise.catch(() => null);
      controls?.close();
      console.warn('screen share', e);
      setScreenOn(false);
      setHudNotice(screenShareErrorMessage(e));
      return;
    }

    const media = stream.getVideoTracks()[0];
    stream.getAudioTracks().forEach((track) => {
      try {
        track.stop();
      } catch {
        /* ignore */
      }
    });
    if (!media || media.readyState === 'ended') {
      shareStartRef.current = false;
      try {
        media?.stop();
      } catch {
        /* ignore */
      }
      const controls = await controlsPromise.catch(() => null);
      controls?.close();
      setHudNotice('No screen was selected.');
      return;
    }
    try {
      media.contentHint = 'detail';
    } catch {
      /* Safari may reject the hint */
    }

    // The controls window had to be opened in the click (user gesture), before
    // we knew what the teacher would pick. An entire-screen capture would
    // record it (PiP is always on top; the popup is a normal window), so close
    // it now, before anything is published, and use the in-page controls.
    const surfaceKind = displaySurfaceOf(media);
    shareSurfaceRef.current = surfaceKind;
    setShareSurface(surfaceKind);
    let controlsReady: Promise<ShareControlSurface | null> = controlsPromise;
    if (shareControlsPlacement(surfaceKind) === 'inline') {
      const early = await controlsPromise.catch(() => null);
      early?.close();
      controlsReady = Promise.resolve(null);
    }

    shareWantedRef.current = true;
    try {
      const published = new LocalVideoTrack(media, undefined, true);
      const { width: capW, height: capH } = media.getSettings();
      const simulcast = SCREEN_SHARE.simulcast && screenShareSimulcastFor(capW, capH);
      const shareOpts = (layered: boolean) => ({
        name: 'screen',
        source: Track.Source.ScreenShare,
        simulcast: layered,
        screenShareEncoding: SCREEN_SHARE.encoding,
        screenShareSimulcastLayers: layered
          ? SCREEN_SHARE.layers.map((l) => new VideoPreset(l.width, l.height, l.maxBitrate, l.maxFramerate))
          : undefined,
      });
      await enqueueLocalPublish(async () => {
        try {
          await localParticipant.publishTrack(published, shareOpts(simulcast));
        } catch (err) {
          // Fail safe: a browser/SFU that rejects the layered publish still
          // gets the plain single-layer share (the pre-simulcast behaviour).
          if (!simulcast || media.readyState !== 'live') throw err;
          console.warn('screen share simulcast failed; publishing a single layer', err);
          await localParticipant.unpublishTrack(published, false).catch(() => undefined);
          await localParticipant.publishTrack(published, shareOpts(false));
        }
      });
    } catch (e) {
      shareWantedRef.current = false;
      shareStartRef.current = false;
      try {
        media.stop();
      } catch {
        /* ignore */
      }
      const controls = await controlsReady.catch(() => null);
      controls?.close();
      shareSurfaceRef.current = '';
      setShareSurface('');
      console.warn('screen share', e);
      setScreenOn(false);
      setHudNotice(screenShareErrorMessage(e));
      return;
    }

    const controls = await controlsReady.catch(() => null);
    // Switched to the entire screen while publishing: same rule.
    if (controls && shareControlsPlacement(displaySurfaceOf(media)) === 'inline') {
      controls.close();
      attachShareSurface(null);
    } else {
      attachShareSurface(controls);
    }
    // No floating window: the controls render in this tab (InlineShareDock).
    // The monitor case explains itself in the dock; nothing else to say here.
    setScreenOn(true);
    setChatOpen(false);
    setRosterOpen(false);
    shareStartRef.current = false;
    await postStage('screen');

    const onMediaEnded = () => {
      if (!shareWantedRef.current || stageSwitchRef.current) return;
      if (
        room.state === ConnectionState.Reconnecting ||
        room.state === ConnectionState.SignalReconnecting
      ) {
        return;
      }
      endShareSession();
      void postStage('idle');
    };
    media.addEventListener('ended', onMediaEnded);
  }, [localParticipant, screenOn, isTeacher, postStage, endShareSession, attachShareSurface, room]);

  async function leave() {
    await roomFetch(code, '/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    room?.disconnect();
    router.push(isTeacher ? '/teacher/dashboard' : '/');
  }

  async function endClass() {
    if (!confirm('End class for everyone?')) return;
    await roomFetch(code, '/end', { method: 'POST' });
    room?.disconnect();
    onClassEnded();
    router.push('/teacher/dashboard');
  }

  async function copyInvite(kind: 'link' | 'code') {
    const text =
      kind === 'link' ? `${window.location.origin}/join/${code.toUpperCase()}` : code.toUpperCase();
    try {
      await navigator.clipboard.writeText(text);
      setInviteCopied(kind);
      window.setTimeout(() => setInviteCopied(''), 2000);
    } catch {
      setHudNotice(`Could not copy. Share: ${text}`);
    }
  }

  async function rotateSample() {
    await fetch('/api/sample/rotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    refresh();
  }

  async function muteStudent(participantId: string, muted: boolean) {
    await roomFetch(code, '/mute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participantId, muted }),
    });
    refresh();
  }

  async function muteAllStudents(muted: boolean) {
    await roomFetch(code, '/mute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true, muted }),
    });
    refresh();
  }

  async function admitStudents(ids?: string[], all?: boolean) {
    await roomFetch(code, '/admit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(all ? { all: true } : { participantIds: ids }),
    });
    refresh();
  }

  function setStudentCameraCap(studentSlots: number) {
    const maxVisibleVideos = Math.min(6, Math.max(1, studentSlots));
    setSampleCap(maxVisibleVideos);
    capQueue.current = capQueue.current
      .catch(() => undefined)
      .then(async () => {
        const res = await roomFetch(code, '/settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ maxVisibleVideos }),
        });
        if (!res.ok) {
          setSampleCap(null);
          setHudNotice('Could not change how many student cameras are on screen.');
        }
        refresh();
      });
  }

  const serverHand = !!(state?.me?.handRaised ?? (state?.raisedHands ?? []).includes(state?.me?.id || ''));
  const [handOverride, setHandOverride] = useState<boolean | null>(null);
  const handRaised = handOverride ?? serverHand;

  useEffect(() => {
    if (handOverride !== null && serverHand === handOverride) setHandOverride(null);
  }, [handOverride, serverHand]);

  async function toggleHand() {
    if (isTeacher) return;
    const next = !handRaised;
    setHandOverride(next);
    try {
      const res = await roomFetch(code, '/hand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raised: next }),
      });
      if (!res.ok) setHandOverride(null);
      refresh();
    } catch (e) {
      setHandOverride(null);
      console.warn('hand', e);
    }
  }

  const studentCount = state?.admitted?.filter((a) => a.role === 'STUDENT').length ?? 0;
  const waitingCount = state?.waiting?.length ?? 0;

  // Teacher layout: the Class panel docks to the stage's corner and the stage
  // makes room for it (left column when expanded, top band when minimized or
  // narrow) instead of being covered by a floating window, shared or not.
  const shareLayout = isTeacher && (screenOn || stageMode === 'screen');
  const stageWrapRef = useRef<HTMLDivElement | null>(null);
  const [dockArea, setDockArea] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  const [dockSpace, setDockSpace] = useState({ left: 0, top: 0 });
  const onDockSpace = useCallback((next: { left: number; top: number }) => {
    setDockSpace((prev) => (prev.left === next.left && prev.top === next.top ? prev : next));
  }, []);
  useEffect(() => {
    if (!isTeacher) {
      setDockArea(null);
      return;
    }
    const el = stageWrapRef.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      const next = {
        top: Math.round(r.top),
        left: Math.round(r.left),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
      setDockArea((prev) =>
        prev &&
        prev.top === next.top &&
        prev.left === next.left &&
        prev.width === next.width &&
        prev.height === next.height
          ? prev
          : next
      );
    };
    read();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(read) : null;
    ro?.observe(el);
    window.addEventListener('resize', read);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', read);
    };
  }, [isTeacher]);

  /** Teacher lowers a student's raised hand. Shared by the roster and the HUD. */
  async function lowerHand(participantId: string) {
    try {
      const res = await roomFetch(code, '/hand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ participantId, raised: false }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error('Lower hand failed', res.status, data);
        setHudNotice(
          (data as { error?: string }).error || `Could not lower hand (${res.status})`
        );
        return;
      }
      refresh();
    } catch (e) {
      console.error('Lower hand error', e);
      setHudNotice('Could not lower hand');
    }
  }
  const controlsProps = {
    micOn: micOn && !effectiveMuted,
    camOn,
    screenOn,
    onToggleMic: () => {
      if ((effectiveMuted || micLockedNoTeacher) && !isTeacher) return;
      setMicOn((v) => !v);
    },
    onToggleCam: () => setCamOn((v) => !v),
    onToggleScreen: toggleScreen,
    onLeave: leave,
    isTeacher,
    canPublishVideo: effectiveCanPublish,
    mutedByTeacher: effectiveMuted,
    micLockReason: micLockedNoTeacher ? MIC_LOCKED_NO_TEACHER : null,
    showScreenShare: isTeacher,
    handRaised,
    onToggleHand: isTeacher ? undefined : toggleHand,
  };

  // —— Student path: always fullscreen stage + floating teacher cam + float chrome ——
  if (!isTeacher) {
    // teacherLive === false: the teacher's media connection is gone (dropped
    // mid-share, closed the tab). Redis may still say stage=screen until the
    // teacher returns, so do not show a stale "Teacher screen" stage.
    const teacherGone = teacherLive === false;
    const teacherHere = teacherIdentities.length > 0 && !teacherGone;
    const showTeacherScreen = effectiveStage === 'screen' && !teacherGone;
    const badge =
      showTeacherScreen
        ? 'Teacher screen'
        : teacherHere
          ? 'Teacher is in the room'
          : 'Waiting for teacher…';

    return (
      <div className="stage-fullscreen">
        <SelectivePublisher
          isTeacher={false}
          canPublishVideo={effectiveCanPublish}
          mutedByTeacher={effectiveMuted || micLockedNoTeacher}
          camDesired={camOn}
          micDesired={micOn}
          localCamStream={localCamStream}
          setLocalCamStream={setLocalCamStream}
          onCameraError={setCamError}
        />
        <StudentMediaPrivacy
          teacherIdentities={teacherIdentities}
          studentIdentities={studentIdentities}
        />
        <RoomAudioRenderer />

        <div className="stage-fullscreen-badge">{badge}</div>

        {camError && camOn && (
          <CameraErrorBanner message={camError} onDismiss={() => setCamError(null)} />
        )}

        {fsPrompt && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="fs-prompt-title"
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 px-6 backdrop-blur-sm"
          >
            <div className="max-w-sm rounded-2xl border border-white/10 bg-surface-1 p-6 text-center shadow-lift">
              <p id="fs-prompt-title" className="font-display text-lg font-semibold">
                You left full screen
              </p>
              <p className="mt-2 text-sm text-slate-400">
                You are still in the class. Return to full screen to keep watching.
              </p>
              <Button className="mt-5" onClick={returnToFullscreen}>
                Return to full screen
              </Button>
            </div>
          </div>
        )}

        <div className="absolute inset-0 z-10">
          {showTeacherScreen ? (
            <TeacherScreenStage
              teacherIdentities={teacherIdentities}
              code={code}
              active={showTeacherScreen}
            />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-ink-950 px-6 text-center text-slate-400">
              <IconVideo size={32} />
              <p className="max-w-sm text-sm">
                {teacherHere
                  ? 'Your teacher is here. Their screen will fill this view when they share it.'
                  : 'Waiting for teacher…'}
              </p>
            </div>
          )}
        </div>

        <TeacherCameraFloat
          teacherIdentities={teacherIdentities}
          roomCode={code}
          selfName={displayName}
          selfStream={localCamStream}
          camOn={camOn}
        />

        <div className="stage-float-chrome" data-float-bound="bottom">
          <Controls
            {...controlsProps}
            variant="float"
            onToggleChat={() => {
              setChatOpen((v) => !v);
            }}
            chatOpen={chatOpen}
            chatUnread={chatUnread}
          />
        </div>

        <FloatingPanel
          title="Chat"
          storageKey="student_chat"
          open={chatOpen}
          onClose={() => setChatOpen(false)}
          width={320}
          height={420}
          defaultPos={() => ({
            x: Math.max(8, window.innerWidth - 340),
            y: Math.max(8, window.innerHeight - 520),
          })}
          badge={
            chatUnread > 0 ? (
              <span className="rounded-full bg-brand-500 px-1.5 text-[9px] font-bold text-white">
                {chatUnread > 9 ? '9+' : chatUnread}
              </span>
            ) : null
          }
        >
          <ChatView
            thread={chatThread}
            isTeacher={false}
            myParticipantId={myParticipantId}
            students={chatStudents}
          />
        </FloatingPanel>
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] max-h-[100dvh] flex-col overflow-hidden bg-surface-0/40">
      <SelectivePublisher
        isTeacher
        canPublishVideo={effectiveCanPublish}
        mutedByTeacher={effectiveMuted}
        camDesired={camOn}
        micDesired={micOn}
        localCamStream={localCamStream}
        setLocalCamStream={setLocalCamStream}
        onCameraError={setCamError}
      />
      <RoomAudioRenderer />

      {/* Top bar */}
      {/* Above every floating panel (z-60 > floats 34–55) and marked as the top
          bound, so panels are clamped below it and never cover Admit. */}
      <header
        data-float-bound="top"
        className="relative z-[60] flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-white/[0.06] bg-surface-1/95 px-3 py-2 backdrop-blur-xl sm:px-4 sm:py-2.5"
      >
        {isTeacher && waitingCount > 0 && (
          <WaitingAdmitBar
            waiting={state?.waiting ?? []}
            onAdmit={(id) => void admitStudents([id])}
            onAdmitAll={() => void admitStudents(undefined, true)}
            onOpenRoster={screenOn ? undefined : () => setRosterOpen(true)}
          />
        )}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={isTeacher ? 'brand' : 'neutral'}>
              {isTeacher ? 'Teacher' : 'Student'}
            </Badge>
            <Badge tone="success" pulse>
              Live
            </Badge>
            {isTeacher && stageMode === 'screen' && (
              <Badge tone="neutral">Stage · Screen</Badge>
            )}
          </div>
          <h1 className="mt-0.5 truncate font-display text-base font-semibold tracking-tight sm:text-xl [@media(max-height:480px)]:text-sm">
            {state?.name || 'Classroom'}
          </h1>
          <p className="truncate text-2xs text-slate-400 sm:text-xs [@media(max-height:480px)]:hidden">
            Code <span className="font-mono text-brand-300">{code}</span>
            {isTeacher ? (
              <>
                {' · '}
                {visibles.length}/{Math.min(sampleCap ?? state?.maxVisibleVideos ?? 6, 6)} in sample
                {' · '}
                {studentCount} student{studentCount === 1 ? '' : 's'}
                {waitingCount > 0 ? ` · ${waitingCount} waiting` : ''}
              </>
            ) : (
              <>
                {' · '}
                <span className="text-emerald-300">Live</span>
              </>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          {isTeacher && (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void copyInvite('link')}
                title={`Copy the student join link for ${code}`}
              >
                {inviteCopied === 'link' ? 'Copied!' : 'Copy invite link'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void copyInvite('code')}
                title="Copy the class code"
              >
                {inviteCopied === 'code' ? 'Copied!' : 'Copy code'}
              </Button>
            </>
          )}
        </div>
      </header>
      {isTeacher && (
        <span className="sr-only" aria-live="polite">
          {waitingCount > 0
            ? `${waitingCount} ${waitingCount === 1 ? 'student is' : 'students are'} waiting to join`
            : ''}
        </span>
      )}

      {hudNotice && isTeacher && !hudOpen && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-b border-amber-400/25 bg-amber-500/10 px-3 py-1.5 text-2xs text-amber-100 sm:px-4"
        >
          <span className="flex-1">{hudNotice}</span>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 font-semibold text-amber-200 hover:underline"
            onClick={() => setHudNotice('')}
          >
            Dismiss
          </button>
        </div>
      )}

      {camError && camOn && (
        <CameraErrorBanner message={camError} onDismiss={() => setCamError(null)} />
      )}

      {/* Main stage — screen share fills the middle when active */}
      <div
        ref={stageWrapRef}
        className="relative min-h-0 flex-1 overflow-hidden"
        // Not sharing: reserve the docked panel's room here (the share stage is
        // absolutely positioned, so it pads its inner box instead, below).
        style={
          isTeacher && !shareLayout
            ? { paddingLeft: dockSpace.left, paddingTop: dockSpace.top }
            : undefined
        }
      >
          <section
            className={
              screenOn || stageMode === 'screen'
                ? 'stage-fill-middle bg-ink-950'
                : 'h-full min-h-0 overflow-y-auto p-3 sm:p-4'
            }
          >
            <div
              className={
                screenOn || stageMode === 'screen'
                  ? 'flex h-full min-h-0 flex-col bg-ink-950'
                  : 'flex min-h-0 flex-col gap-3 pb-2'
              }
              style={
                shareLayout
                  ? { paddingLeft: dockSpace.left, paddingTop: dockSpace.top }
                  : undefined
              }
            >
              <ParticipantGrid
                visibleIdentities={visibles}
                isTeacher={isTeacher}
                teacherIdentities={teacherIdentities}
                annotate={annotate}
                annotateOn={annotateOn}
                annotateMode={annotateMode}
                annotateColor={annotateColor}
                localShareSurface={shareSurface}
                onStopShare={() => void toggleScreen()}
                localPreview={
                  <LocalPreview
                    stream={localCamStream}
                    label={displayName}
                    inSample={effectiveCanPublish}
                    showMayBeVisible={isTeacher}
                    hideSampleStatus={!isTeacher}
                  />
                }
              />
            </div>
          </section>


        <FloatingPanel
          title="Roster"
          storageKey="teacher_roster"
          open={rosterOpen && !screenOn}
          onClose={() => setRosterOpen(false)}
          width={320}
          height={480}
          defaultPos={() => ({ x: Math.max(8, window.innerWidth - 340), y: 72 })}
          badge={
            waitingCount > 0 ? (
              <span className="rounded-full bg-amber-500 px-1.5 text-[9px] font-bold text-white">
                {waitingCount}
              </span>
            ) : null
          }
        >
          <div className="flex h-full min-h-0 flex-col space-y-3 overflow-hidden">
            {/* Waiting students first, so Admit is the first thing in the roster. */}
            {waitingCount > 0 && (
              <div className="shrink-0 rounded-xl border border-amber-400/30 bg-amber-500/10 p-2.5" data-no-drag>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-2xs font-semibold uppercase tracking-wider text-amber-200">
                    Waiting ({waitingCount})
                  </h3>
                  {waitingCount > 1 && (
                    <Button size="sm" variant="warning" onClick={() => void admitStudents(undefined, true)}>
                      Admit all
                    </Button>
                  )}
                </div>
                <ul className="mt-2 max-h-40 space-y-1.5 overflow-y-auto text-sm">
                  {state!.waiting!.map((p) => (
                    <li
                      key={p.id}
                      className="flex items-center justify-between gap-2 rounded-lg bg-black/15 px-2 py-1.5"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <Avatar name={p.displayName} size="sm" />
                        <div className="min-w-0">
                          <span className="block truncate">{p.displayName}</span>
                          <RosterMeta info={p} />
                        </div>
                      </div>
                      <Button size="sm" variant="warning" onClick={() => void admitStudents([p.id])}>
                        Admit
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex shrink-0 flex-wrap gap-2" data-no-drag>
              <Button size="sm" variant="warning" onClick={() => muteAllStudents(true)}>
                Mute all
              </Button>
              <Button size="sm" variant="secondary" onClick={() => muteAllStudents(false)}>
                Unmute all
              </Button>
            </div>
            <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto text-sm" data-no-drag>
              {(state?.admitted?.length || 0) === 0 && (
                <EmptyState
                  icon={<IconUsers size={22} />}
                  title="No one here yet"
                  description="Admitted participants will show up in this roster."
                  className="py-6"
                />
              )}
              {[...(state?.admitted ?? [])]
                .sort((a, b) => {
                  const ah =
                    a.role === 'STUDENT' &&
                    (a.handRaised || (state?.raisedHands ?? []).includes(a.id))
                      ? 1
                      : 0;
                  const bh =
                    b.role === 'STUDENT' &&
                    (b.handRaised || (state?.raisedHands ?? []).includes(b.id))
                      ? 1
                      : 0;
                  if (ah !== bh) return bh - ah;
                  if (a.role !== b.role) return a.role === 'TEACHER' ? -1 : 1;
                  return a.displayName.localeCompare(b.displayName);
                })
                .map((p) => {
                  const raised =
                    p.role === 'STUDENT' &&
                    (p.handRaised || (state?.raisedHands ?? []).includes(p.id));
                  return (
                    <li
                      key={p.id}
                      className={cn(
                        'rounded-xl border bg-black/20 px-3 py-2.5',
                        raised ? 'border-amber-400/40 bg-amber-500/10' : 'border-white/[0.05]'
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <Avatar name={p.displayName} size="sm" />
                          <div className="min-w-0">
                            <p className="flex items-center gap-1.5 truncate font-medium text-slate-100">
                              {raised && (
                                <span
                                  className="inline-flex shrink-0 text-amber-300"
                                  title="Hand raised"
                                  aria-label="Hand raised"
                                >
                                  <IconHand size={14} />
                                </span>
                              )}
                              <span className="truncate">
                                {p.displayName}
                                {p.role === 'TEACHER' ? ' · Teacher' : ''}
                              </span>
                            </p>
                            {p.role === 'STUDENT' && <RosterMeta info={p} />}
                            {p.mutedByTeacher && p.role === 'STUDENT' && (
                              <span className="chip-muted mt-0.5">Muted by teacher</span>
                            )}
                            {raised && (
                              <span className="mt-0.5 inline-flex items-center gap-1 text-2xs font-semibold text-amber-300">
                                ✋ Hand raised
                              </span>
                            )}
                          </div>
                        </div>
                        {p.role === 'STUDENT' && (
                          <span className={p.isVisible ? 'chip-sample' : 'chip-local'}>
                            {p.isVisible ? 'In sample' : 'Local'}
                          </span>
                        )}
                      </div>
                      {p.role === 'STUDENT' && (
                        <div className="mt-2 flex flex-wrap gap-3">
                          <button
                            type="button"
                            className="text-xs font-medium text-brand-300 hover:underline"
                            onClick={() => muteStudent(p.id, !p.mutedByTeacher)}
                          >
                            {p.mutedByTeacher ? 'Unmute student' : 'Mute student'}
                          </button>
                          {raised && (
                            <button
                              type="button"
                              className="text-xs font-medium text-amber-300 hover:underline"
                              onClick={() => void lowerHand(p.id)}
                            >
                              Lower hand
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
            </ul>
          </div>
        </FloatingPanel>

        <FloatingPanel
          title="Chat"
          storageKey="teacher_chat"
          open={chatOpen && !screenOn}
          onClose={() => setChatOpen(false)}
          width={320}
          height={420}
          defaultPos={() => ({
            x: Math.max(8, window.innerWidth - 340),
            y: Math.max(8, window.innerHeight - 540),
          })}
          badge={
            chatUnread > 0 ? (
              <span className="rounded-full bg-brand-500 px-1.5 text-[9px] font-bold text-white">
                {chatUnread > 9 ? '9+' : chatUnread}
              </span>
            ) : null
          }
        >
          <ChatView
            thread={chatThread}
            isTeacher
            myParticipantId={myParticipantId}
            students={chatStudents}
          />
        </FloatingPanel>
      </div>

      <TeacherPeersFloat
        roomCode={code}
        teacherIdentities={teacherIdentities}
        visibleIdentities={visibles}
        selfName={displayName}
        selfStream={localCamStream}
        onSlotsChange={(slots) => void setStudentCameraCap(slots)}
        dock={dockArea}
        sharing={shareLayout}
        onDockSpace={onDockSpace}
      />

      {/* Share controls: in the floating window for window/tab captures; in
          this tab (draggable dock) for entire-screen captures or when no
          window could be opened. Never both. */}
      {isTeacher && screenOn && (
        <ShareHudSlot
          floating={!!shareMount}
          popOut={
            shareControlsPlacement(shareSurface) === 'inline' ? undefined : () => reopenShareControls()
          }
          hint={shareControlsPlacement(shareSurface) === 'inline' ? MONITOR_SHARE_HINT : undefined}
        >
          <TeacherShareHud
            host={shareMount}
            hostWindow={shareWindow}
            inline={!shareMount}
            admitted={state?.admitted ?? []}
            waiting={(state?.waiting ?? []).map((w) => ({
              id: w.id,
              displayName: rosterLabel(w),
              role: 'STUDENT',
            }))}
            waitingCount={waitingCount}
            onAdmit={(id) => void admitStudents([id])}
            onAdmitAll={() => void admitStudents(undefined, true)}
            teacherMicOn={micOn && !effectiveMuted}
            onToggleTeacherMic={() => setMicOn((v) => !v)}
            onStopSharing={() => void toggleScreen()}
            onMuteStudent={(id, muted) => void muteStudent(id, muted)}
            onMuteAll={(muted) => void muteAllStudents(muted)}
            onLowerHand={(id) => void lowerHand(id)}
            chatUnread={chatUnread}
            onChatOpenChange={setHudChatOpen}
            chat={
              <ChatView
                thread={chatThread}
                isTeacher
                myParticipantId={myParticipantId}
                students={chatStudents}
              />
            }
            annotate={annotate}
            annotateOn={annotateOn}
            onAnnotateOnChange={setAnnotateOn}
            annotateMode={annotateMode}
            onAnnotateModeChange={setAnnotateMode}
            annotateColor={annotateColor}
            onAnnotateColorChange={setAnnotateColor}
            annotateUnavailable={
              showLocalSharePreview(shareSurface)
                ? undefined
                : 'Drawing needs a window or tab share (an entire-screen share has no preview to draw on)'
            }
            notice={shareMount ? hudNotice || undefined : undefined}
          />
        </ShareHudSlot>
      )}

      {/* Bottom dock — never covers content */}
      <footer data-float-bound="bottom" className="shrink-0 border-t border-white/[0.06] bg-surface-1/90 px-3 py-2.5 backdrop-blur-xl sm:px-4">
        <Controls
          {...controlsProps}
          onPrepareScreenShare={() => {
            if (!screenOn && canShareScreen()) preopenShareControls();
          }}
          onEnd={endClass}
          onRotateSample={rotateSample}
          onMuteAll={() => muteAllStudents(true)}
          onUnmuteAll={() => muteAllStudents(false)}
          onToggleChat={screenOn ? undefined : () => setChatOpen((v) => !v)}
          chatOpen={chatOpen}
          chatUnread={chatUnread}
          onToggleRoster={screenOn ? undefined : () => setRosterOpen((v) => !v)}
          rosterOpen={rosterOpen}
          rosterBadge={waitingCount}
        />
      </footer>
    </div>
  );
}

/**
 * Waiting students, pinned first in the teacher header (always visible, above
 * every floating panel, also while sharing). Admits directly; "Roster" opens
 * the full list.
 */
function WaitingAdmitBar({
  waiting,
  onAdmit,
  onAdmitAll,
  onOpenRoster,
}: {
  waiting: Array<{ id: string; displayName: string } & RosterInfo>;
  onAdmit: (id: string) => void;
  onAdmitAll: () => void;
  onOpenRoster?: () => void;
}) {
  const first = waiting[0];
  if (!first) return null;
  const n = waiting.length;
  return (
    <div
      role="status"
      aria-live="polite"
      className="order-first flex w-full min-w-0 items-center gap-1.5 rounded-xl border border-amber-400/40 bg-amber-500/15 px-2 py-1 text-xs text-amber-50"
    >
      <IconUsers size={14} className="shrink-0 text-amber-300" />
      <span className="min-w-0 flex-1 truncate font-semibold">
        {n === 1 ? `${first.displayName} is waiting` : `${n} students waiting`}
      </span>
      <Button variant="warning" size="sm" onClick={() => onAdmit(first.id)} title={`Admit ${rosterLabel(first)}`}>
        {n === 1 ? 'Admit' : `Admit ${first.displayName.split(' ')[0]}`}
      </Button>
      {n > 1 && (
        <Button variant="warning" size="sm" onClick={onAdmitAll}>
          Admit all ({n})
        </Button>
      )}
      {onOpenRoster && (
        <Button variant="ghost" size="sm" onClick={onOpenRoster} aria-label="Open roster">
          Roster
        </Button>
      )}
    </div>
  );
}

/** Floating window → the HUD portals itself; otherwise wrap it in the in-page dock. */
function ShareHudSlot({
  floating,
  popOut,
  hint,
  children,
}: {
  floating: boolean;
  popOut?: () => void;
  hint?: string;
  children: ReactNode;
}) {
  if (floating) return <>{children}</>;
  return (
    <InlineShareDock onPopOut={popOut} hint={hint}>
      {children}
    </InlineShareDock>
  );
}

export function ClassroomRoom({ code }: { code: string }) {
  const router = useRouter();
  const [tokenData, setTokenData] = useState<TokenPayload | null>(null);
  const [error, setError] = useState('');
  const [classEnded, setClassEnded] = useState(false);
  const [isTeacher, setIsTeacher] = useState(false);
  const [displayName, setDisplayName] = useState('You');
  const [canPublishVideo, setCanPublishVideo] = useState(false);

  const markEnded = useCallback(() => {
    setClassEnded(true);
    setTokenData(null);
  }, []);

  const load = useCallback(async () => {
    // If this tab is not explicitly a student tab, prefer the teacher session.
    // Stale sessionStorage 'student' from a prior join-as-student on the same
    // phone/browser was flipping teachers into the student UI after lobby enter.
    let tabRole = getClassroomRole(code);
    if (tabRole !== 'student') {
      try {
        const meRes = await fetch('/api/auth/me', { cache: 'no-store' });
        const me = await meRes.json();
        if (me.role === 'teacher') {
          await claimTeacherTab(code);
          tabRole = 'teacher';
        }
      } catch {
        /* ignore */
      }
    }

    const stateRes = await roomFetch(code, '/state');
    const state = await stateRes.json();
    if (!stateRes.ok) {
      if (stateRes.status === 410 || state.ended) {
        setClassEnded(true);
        return;
      }
      setError(state.error || 'Room error');
      return;
    }
    if (state.status === 'ENDED' || state.ended) {
      setClassEnded(true);
      return;
    }
    if (state.public) {
      router.replace(`/join/${code}?as=student`);
      return;
    }
    if (state.me?.status === 'WAITING') {
      router.replace(`/join/${code}?waiting=1&as=student`);
      return;
    }

    // Prefer teacher whenever the server says so and this tab did not
    // explicitly choose join-as-student (sessionStorage or act-as cookie).
    const explicitStudent =
      getClassroomRole(code) === 'student' || !!state.actingAsStudent;
    if (state.isTeacher && !explicitStudent) {
      rememberClassroomRole(code, 'teacher');
      setIsTeacher(true);
    } else {
      rememberClassroomRole(code, 'student');
      setIsTeacher(false);
    }

    setDisplayName(state.me?.displayName || 'You');
    setCanPublishVideo(!!state.me?.canPublishVideo);

    const tokRes = await roomFetch(code, '/token');
    const tok = await tokRes.json();
    if (!tokRes.ok) {
      if (tokRes.status === 410 || tok.ended) {
        setClassEnded(true);
        return;
      }
      setError(tok.error || 'Could not get media token');
      return;
    }
    setTokenData(tok);
  }, [code, router]);

  useEffect(() => {
    load();
  }, [load]);

  // NOTE: room state is polled by useRoomState() inside RoomInner (2s), which
  // also surfaces the ENDED transition via onClassEnded(). A second /state
  // poller used to live here and doubled the load on the hottest endpoint in the
  // app for no behavioural gain — the props below are initial values that
  // effectiveCanPublish / effectiveMuted immediately override from `state`.

  if (classEnded) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6">
        <div className="max-w-md rounded-2xl border border-white/10 bg-surface-1 p-8 text-center shadow-lift">
          <p className="font-display text-2xl font-semibold tracking-tight">Class ended</p>
          <p className="mt-2 text-sm text-slate-400">
            Your teacher has ended this class. You can leave this page.
          </p>
          <Button className="mt-6" variant="secondary" onClick={() => router.push('/')}>
            Home
          </Button>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6">
        <p className="text-danger-fg">{error}</p>
        <Button variant="secondary" onClick={() => router.push('/')}>
          Home
        </Button>
      </main>
    );
  }

  if (!tokenData) {
    return <PageLoading label="Connecting to classroom…" />;
  }

  return (
    <LiveKitRoom
      token={tokenData.token}
      serverUrl={tokenData.url}
      connect
      video={false}
      audio={false}
      options={{
        // Minimizing the window must not drop the room. pagehide is how some
        // browsers report that; the socket still closes if the tab is destroyed.
        disconnectOnPageLeave: false,
        // Subscribers ask the SFU for the video layer that fits the element
        // showing it (teacher camera: 180p/360p/720p simulcast). Kept playing in
        // background tabs so a student alt-tabbing back never sees a frozen
        // share while the stream resumes.
        adaptiveStream: { pauseVideoInBackground: false },
        // Publishers stop encoding simulcast layers nobody is receiving.
        dynacast: true,
        // Per-track options in SelectivePublisher / screen share override these.
        publishDefaults: {
          simulcast: false,
          backupCodec: false,
          dtx: true,
          red: true,
          audioPreset: AudioPresets.speech,
          videoEncoding: STUDENT_CAMERA.encoding,
          screenShareEncoding: SCREEN_SHARE.encoding,
        },
      }}
      // Students never auto-subscribe: StudentMediaPrivacy subscribes them to
      // the teacher's tracks and classmates' microphones only, never to other
      // students' cameras. The teacher keeps auto-subscribe (sampled cameras).
      connectOptions={{ peerConnectionTimeout: 20_000, autoSubscribe: isTeacher }}
      className="h-[100dvh] overflow-hidden"
      onError={(e) => console.error('LiveKit', e)}
    >
      <RoomInner
        code={code}
        isTeacher={isTeacher}
        canPublishVideo={canPublishVideo}
        mutedByTeacher={tokenData.mutedByTeacher}
        visibleIdentities={tokenData.visibleIdentities}
        displayName={displayName}
        onVisibilityChange={setCanPublishVideo}
        onClassEnded={markEnded}
      />
    </LiveKitRoom>
  );
}

/** "Name · Roll 12 · 7-B · late" for compact lists (share HUD). */
function rosterLabel(p: { displayName: string } & RosterInfo): string {
  const bits = [p.displayName];
  if (p.rollNumber) bits.push(`Roll ${p.rollNumber}`);
  if (p.gradeDivision) bits.push(p.gradeDivision);
  if (p.late) bits.push('late');
  if (p.viaSchoolApp && !p.onTimetable) bits.push('not on timetable');
  if (!p.viaSchoolApp) bits.push('guest');
  return bits.join(' · ');
}

/** Roll number, grade-division and timetable / late markers under a student's name (teacher roster). */
function RosterMeta({ info }: { info: RosterInfo }) {
  if (info.viaSchoolApp === undefined) return null;
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-1 text-2xs text-slate-400">
      {info.rollNumber && <span>Roll {info.rollNumber}</span>}
      {info.gradeDivision && <span>· {info.gradeDivision}</span>}
      {info.viaSchoolApp ? (
        info.onTimetable ? (
          <span className="rounded bg-emerald-500/15 px-1 font-semibold text-emerald-200">On timetable</span>
        ) : (
          <span className="rounded bg-amber-500/15 px-1 font-semibold text-amber-100">Not on timetable</span>
        )
      ) : (
        <span className="rounded bg-white/10 px-1 font-semibold text-slate-300">Guest (no school ID)</span>
      )}
      {info.late && <span className="rounded bg-red-500/15 px-1 font-semibold text-red-200">Late</span>}
    </span>
  );
}

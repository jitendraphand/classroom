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
import type { TrackReference } from '@livekit/components-react';
import {
  Track,
  LocalVideoTrack,
  createLocalAudioTrack,
  LocalAudioTrack,
  RoomEvent,
  ConnectionState,
  DisconnectReason,
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
import { TEACHER_ABSENCE_GRACE_MS } from '@/lib/graceTimer';
import { SESSION_CHECK_EVENT, SESSION_ENDED_EVENT, isEndedReason, loginHref } from '@/lib/sessionClient';
import { useRoomState, type RosterInfo } from '@/hooks/useRoomState';
import { compactViewport, studentChatBox, usePseudoFullscreen, useViewport } from '@/hooks/useStudentLayout';
import { shortName } from '@/lib/displayNames';
import { Controls } from './Controls';
import { LocalPreview } from './LocalPreview';
import { DrawOverlay, ShareDrawingProvider, useDrawingActions, useShareDrawing } from './ShareDrawing';
import { ChatView, useChatThread } from './Chat';
import { useStudentFocus } from './useStudentFocus';
import { countFocusAlerts, focusLabel, isFocusAlert, needsCover } from '@/lib/focusStatus';
import { FloatingPanel, useFloatDrag, readFloatPref, writeFloatPref, type FloatPos } from './FloatingPanel';
import { shareControlsPlacement, showLocalSharePreview } from '@/lib/floatGeometry';
import { candidateScreens, surfaceFromTrack, windowPositionsTrusted } from '@/lib/screenMask';
import {
  maskPipelineSupported,
  resolveScreenGeometry,
  startMaskPipeline,
  type MaskPipeline,
} from '@/lib/screenMaskPipeline';
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
import { IconDoor, IconHand, IconHandDown, IconMic, IconMicOff, IconPen, IconPin, IconScreen, IconSearch, IconUserPlus, IconUsers, IconVideo } from '@/components/ui/Icons';
import {
  panelSlotsForCap,
  pickTiles,
  sortRoster,
  studentCapForSlots,
  teacherTabTitle,
  videosShown,
  type PanelSlots,
} from '@/lib/classSlots';
import { cn } from '@/lib/cn';
import {
  closeAllSideWindows,
  closeSideWindow,
  closeSideWindowObject,
  openSideWindow,
  sideWindow,
  sideWindows,
  SideWindowPortal,
  useSideWindows,
} from './shareSideWindows';
import { MIC_LOCKED_NO_TEACHER } from '@/lib/teacherPresenceLogic';
import {
  roomFetch,
  rememberClassroomRole,
  getClassroomRole,
  claimTeacherTab,
  isSchoolStudentTab,
  markSchoolStudentTab,
  studentHomePath,
} from '@/lib/classroomClient';
import { forwardActivityFrom, setLiveSession } from '@/lib/liveSession';
import { filterPeople } from '@/lib/peopleSearch';
import {
  PEER_WIN_TILE_W,
  peerWindowGrid,
  peerWindowOuterSize,
  peerWindowTileCount,
  peerWindowTileWForWidth,
} from '@/lib/peerWindow';
import {
  cameraProfile,
  SCREEN_SHARE,
  screenShareSimulcastFor,
  shareEncodingsFor,
  shareProfile,
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
    // Grace period: a teacher who was here and drops (device switch, reload,
    // blip) still counts as present for TEACHER_ABSENCE_GRACE_MS, matching the
    // server, so students see no "teacher left" flicker or mic lock.
    let shown: boolean | null = null;
    let grace: number | null = null;
    const show = (v: boolean | null) => {
      shown = v;
      setLive(v);
    };
    const clearGrace = () => {
      if (grace !== null) window.clearTimeout(grace);
      grace = null;
    };
    const teacherHere = () =>
      Array.from(room.remoteParticipants.values()).some((p) => isTeacherParticipant(p, set));
    const update = () => {
      if (room.state !== ConnectionState.Connected) {
        if (room.state === ConnectionState.Disconnected) {
          clearGrace();
          show(null);
        }
        return;
      }
      if (teacherHere()) {
        clearGrace();
        show(true);
        return;
      }
      if (shown !== true) {
        show(false);
        return;
      }
      if (grace === null) {
        grace = window.setTimeout(() => {
          grace = null;
          if (room.state === ConnectionState.Connected && !teacherHere()) show(false);
        }, TEACHER_ABSENCE_GRACE_MS);
      }
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
      clearGrace();
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
  localShareSurface = '',
  onStopShare,
  entireShareInfo,
}: {
  entireShareInfo?: EntireShareInfo;
  /** What this teacher tab is capturing; decides whether the local share may be previewed. */
  localShareSurface?: string;
  onStopShare?: () => void;
  visibleIdentities: string[];
  isTeacher: boolean;
  localPreview: ReactNode;
  teacherIdentities: string[];
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
    // Teacher: the stage stays empty until a share; the teacher's own camera
    // preview lives only in the docked Class panel (no duplicate tile here).
    if (isTeacher) return <div className="stage-empty min-h-0 flex-1" aria-hidden />;
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
              <EntireScreenShareCard
                key={`${t.participant.identity}-${t.source}`}
                onStop={onStopShare}
                info={entireShareInfo}
              />
            ) : (
            <TeacherShareTile key={`${t.participant.identity}-${t.source}`} trackRef={t} />
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

              </div>
            </div>
          );
        })}
        {!isTeacher && <div className={hasScreen ? 'max-h-36' : undefined}>{localPreview}</div>}
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
export type EntireShareInfo = {
  /** Share controls (hands, chat, roster) are docked in this tab, not floating on the screen. */
  controlsInTab: boolean;
  hands: number;
};

/**
 * Entire-screen share: the teacher's own picture cannot be shown here (it
 * would be captured again), so students' strokes are previewed on a dark box
 * of the screen's shape instead.
 */
function EntireShareDrawingPreview() {
  const d = useShareDrawing();
  if (!d || (!d.strokes.length && !d.holder)) return null;
  const aspect = typeof window !== 'undefined' && window.screen?.height ? window.screen.width / window.screen.height : 16 / 9;
  return (
    <div className="mt-3 text-left">
      <p className="mb-1 inline-flex items-center gap-1 text-2xs font-semibold text-slate-300">
        <IconPen size={12} />
        {d.holder ? `${d.holder.name} is drawing` : 'Student drawing'} (what students see over your screen)
      </p>
      <div className="draw-preview" style={{ aspectRatio: String(aspect) }}>
        <DrawOverlay aspect={aspect} interactive={false} />
      </div>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        {d.strokes.length > 0 && (
          <button
            type="button"
            className="rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-2xs font-semibold text-slate-100 hover:bg-white/10"
            onClick={() => void d.post({ action: 'clear' })}
          >
            Clear drawing
          </button>
        )}
        {d.holder && (
          <button
            type="button"
            className="rounded-lg border border-red-400/30 bg-red-500/10 px-2.5 py-1 text-2xs font-semibold text-red-200 hover:bg-red-500/20"
            onClick={() => void d.post({ action: 'revoke' })}
          >
            Revoke {d.holder.name}
          </button>
        )}
      </div>
    </div>
  );
}

function EntireScreenShareCard({ onStop, info }: { onStop?: () => void; info?: EntireShareInfo }) {
  const controlsInTab = info?.controlsInTab ?? true;
  const hands = info?.hands ?? 0;
  return (
    <div className="video-tile relative flex h-full min-h-0 w-full items-center justify-center overflow-hidden bg-ink-950 p-4">
      <div className="max-w-md rounded-2xl border border-white/10 bg-surface-1/90 p-5 text-center shadow-lift">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-brand-500/20 text-brand-300">
          <IconScreen size={20} />
        </div>
        <p className="font-display text-base font-semibold">You&apos;re sharing your entire screen</p>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
          Students see your screen live. Your own preview is hidden here so it is not captured again.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-slate-400">
          {controlsInTab
            ? 'Raised hands, chat and the roster are in Share controls in this tab. Keep this tab where you can reach it (beside your slides or on a second monitor) instead of minimising it; the tab title shows new hands and messages.'
            : 'Share controls float on your screen (hidden from students), so raised hands, chat and the roster stay in reach while you present.'}
        </p>
        {hands > 0 && (
          <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-2xs font-semibold text-amber-200">
            <IconHand size={12} />
            {hands} raised {hands === 1 ? 'hand' : 'hands'}
          </p>
        )}
        <EntireShareDrawingPreview />
        {onStop && (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <Button variant="danger" size="sm" onClick={onStop}>
              <IconScreen size={14} />
              Stop sharing
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function TeacherShareTile({ trackRef }: { trackRef: ReturnType<typeof useTracks>[number] }) {
  const t = trackRef;
  return (
    <div className="video-tile relative min-h-0 h-full w-full overflow-hidden bg-black">
      <div className="relative h-full w-full">
        {t.publication?.track ? (
          <VideoTrack trackRef={t} className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full items-center justify-center bg-ink-900 text-slate-400">
            No screen
          </div>
        )}
        {/* What students draw, over the teacher's in-page preview (never on the real desktop). */}
        <DrawOverlay interactive={false} />
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
        </span>
      </div>
    </div>
  );
}

export function TeacherScreenStage({ teacherIdentities }: { teacherIdentities: string[] }) {
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

  if (screens.length === 0) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-ink-950 text-slate-400">
        <IconScreen size={32} />
        <p className="text-sm">Waiting for teacher screen…</p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full bg-black">
      {screens.map((t) => (
        <div key={`${t.participant.identity}-${t.source}`} className="absolute inset-0">
          <div className="relative h-full w-full">
            <div className="relative h-full w-full">
              {t.publication?.track ? (
                <VideoTrack trackRef={t} className="h-full w-full object-contain" />
              ) : (
                <div className="flex h-full items-center justify-center text-slate-400">No screen</div>
              )}
              {/* Students' drawing (and the allowed student's drawing surface). */}
              <DrawOverlay />
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
    // Missing displaySurface → track label → otherwise 'monitor' (fail closed).
    return surfaceFromTrack(
      (track.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface,
      track.label
    );
  } catch {
    return 'monitor';
  }
}

const MONITOR_SHARE_HINT =
  'Entire screen: this browser cannot hide a floating window from the capture, so Share controls (raised hands, chat, roster) stay in this tab. Keep it beside what you present instead of minimising it. Chrome or Edge can float them.';
const MONITOR_SCREENS_HINT =
  'Several monitors: Share controls can float on your screen once you allow "Window management" (so they can be hidden from students). Until then they stay in this tab — allow it, then start the share again.';
const MONITOR_POSITION_HINT =
  'Entire screen on a system that does not report window positions (Linux on Wayland): Share controls stay in this tab so students never see them. Keep this tab in reach to see hands and chat.';
const MONITOR_UNSAFE_HINT =
  'Share controls moved into this tab because their spot on the shared screen could not be tracked (students must never see them). Raised hands, chat and the roster are here; the tab title shows new hands and messages.';

type MaskFallback = '' | 'unsupported' | 'screens' | 'unsafe' | 'position';

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
/**
 * Display-media audio constraints. Processing is off (it is a video's audio,
 * not a voice). `restrictOwnAudio` keeps this tab's own output (students'
 * voices) out of a system-audio capture, so students do not hear an echo of
 * themselves; `suppressLocalAudioPlayback: false` keeps a shared tab audible
 * for the teacher. Browsers ignore members they do not know.
 */
const SCREEN_SHARE_AUDIO_CAPTURE = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  restrictOwnAudio: true,
  suppressLocalAudioPlayback: false,
} as MediaTrackConstraints;

/** adaptiveStream pixel density: 1 on phones (bandwidth), the screen's ratio elsewhere. */
function subscriberPixelDensity(): number | 'screen' {
  if (typeof window === 'undefined') return 'screen';
  try {
    const coarse = window.matchMedia?.('(pointer: coarse)').matches;
    const small = Math.min(window.screen?.width || 0, window.screen?.height || 0) < 600;
    return coarse && small ? 1 : 'screen';
  } catch {
    return 'screen';
  }
}

function captureScreen(videoMode = false): Promise<MediaStream> {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const safari = /safari/i.test(ua) && !/chrome|chromium|crios|edg|android|fxios/i.test(ua);
  // Safari has no display-media audio; asking for it can reject the call.
  const bare = () =>
    navigator.mediaDevices.getDisplayMedia({ video: true, audio: !safari ? SCREEN_SHARE_AUDIO_CAPTURE : false });
  if (safari) return bare();

  const withHints = {
    video: { ...SCREEN_SHARE.capture, ...shareProfile(videoMode).capture },
    // Tab audio (any Chromium OS) or system audio (entire screen, Windows /
    // ChromeOS). The picker shows a "Share audio" checkbox; unticked = no track.
    audio: SCREEN_SHARE_AUDIO_CAPTURE,
    // The classroom tab is never offered: sharing it would mirror the page
    // (and any in-page share controls) back to the students.
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    systemAudio: 'include',
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
  slots: slotsProp,
  dock = null,
  sharing = false,
  onDockSpace,
  focusAlerts = {},
  pinnedIdentities = [],
  onTogglePin,
  portalWindow = null,
}: {
  /**
   * While sharing: render the panel inside this separate window (beside the
   * share toolbar) instead of the classroom tab. Same tiles, pins, rotation.
   */
  portalWindow?: Window | null;
  /** LiveKit identity → "Left fullscreen" / "Switched away". */
  focusAlerts?: Record<string, string>;
  /** Students the teacher pinned (oldest first): they keep a tile, bypassing rotation. */
  pinnedIdentities?: string[];
  /** Pin / unpin a student from their tile. */
  onTogglePin?: (identity: string, pinned: boolean) => void;
  roomCode: string;
  teacherIdentities: string[];
  visibleIdentities: string[];
  selfName: string;
  selfStream: MediaStream | null;
  /** Student-camera count that fills this window (tiles minus the teacher). */
  onSlotsChange?: (studentSlots: number) => void;
  /** Panel size chosen by the room (synced with the server student cap). */
  slots?: PanelSlots | null;
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
  useEffect(() => {
    if (slotsProp && slotsProp !== slotCount) setSlotCount(slotsProp);
    // Only follow the room's value when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotsProp]);
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
  const portal = !!portalWindow && !portalWindow.closed;
  const docked = !!dock && !floating && !portal;
  const sharingDock = docked && sharing;
  // Minimized state during a share. Starts collapsed at every share; the
  // teacher's saved (non-share) minimized preference is untouched.
  const [shareMinimized, setShareMinimized] = useState(true);
  useEffect(() => {
    if (sharingDock) setShareMinimized(true);
  }, [sharingDock]);
  const isMin = portal ? false : sharingDock ? shareMinimized : minimized;
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
    const ensure = (fromTimer = false) => {
      let changedAny = !fromTimer;
      for (const p of Array.from(room.remoteParticipants.values())) {
        if (isTeacherParticipant(p, teacherSet)) continue;
        const pub = p.getTrackPublication(Track.Source.Camera);
        if (pub && !pub.isSubscribed) {
          changedAny = true;
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
      // The 2 s timer is a safety net: re-render only when it changed something.
      if (changedAny) setTick((n) => n + 1);
    };
    const onEvent = () => ensure(false);
    ensure();
    room.on(RoomEvent.TrackPublished, onEvent);
    room.on(RoomEvent.TrackSubscribed, onEvent);
    room.on(RoomEvent.ParticipantConnected, onEvent);
    room.on(RoomEvent.ParticipantDisconnected, onEvent);
    room.on(RoomEvent.TrackMuted, onEvent);
    room.on(RoomEvent.TrackUnmuted, onEvent);
    room.on(RoomEvent.TrackUnpublished, onEvent);
    room.on(RoomEvent.TrackUnsubscribed, onEvent);
    const iv = window.setInterval(() => ensure(true), 3000);
    return () => {
      room.off(RoomEvent.TrackPublished, onEvent);
      room.off(RoomEvent.TrackSubscribed, onEvent);
      room.off(RoomEvent.ParticipantConnected, onEvent);
      room.off(RoomEvent.ParticipantDisconnected, onEvent);
      room.off(RoomEvent.TrackMuted, onEvent);
      room.off(RoomEvent.TrackUnmuted, onEvent);
      room.off(RoomEvent.TrackUnpublished, onEvent);
      room.off(RoomEvent.TrackUnsubscribed, onEvent);
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
    const pins = pinnedIdentities.filter((id) => pool.includes(id));
    const studentSlots = Math.max(0, slotCount - 1);

    // Rotation runs among everyone who is not pinned / speaking. Pinned
    // students (teacher), then the active speaker, then sticky speakers take
    // tiles first (see pickTiles in lib/classSlots).
    const rest = pool.filter((id) => !pins.includes(id) && id !== speakingId && !sticky.includes(id));
    const prevMosaic = mosaicPoolRef.current.filter((id) => rest.includes(id));
    const needSlots = Math.max(0, studentSlots - pins.length - sticky.length);
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

    // Never backfill with students who are not publishing a sample camera.
    // The grid still paints `slotCount` cells; the rest stay blank.
    return pickTiles({
      pool: [...pins, ...(speakingId ? [speakingId] : []), ...sticky, ...mosaic].filter((id) => pool.includes(id)),
      teacherPins: pins,
      speakingId,
      sticky,
      rotation: mosaic,
      studentSlots,
    });
  }, [
    visibleIdentities,
    teacherIdentities,
    room,
    speakingId,
    rotationTick,
    slotCount,
    tick,
    stickyVersion,
    pinnedIdentities,
  ]);

  const cells: Array<string | null> = ['__self__'];
  for (let i = 0; i < slotCount - 1; i++) cells.push(peerIds[i] ?? null);

  // After more tiles are requested (2→6) or the sample changes, newly sampled
  // students take a few seconds to (re)publish and subscribe. Show
  // "Connecting…" in the blank tiles meanwhile instead of flashing
  // "Off camera"; only students actually in the room can fill them.
  const visibleKey = visibleIdentities.join(',');
  const [settling, setSettling] = useState(false);
  useEffect(() => {
    setSettling(true);
    const t = window.setTimeout(() => setSettling(false), 12_000);
    return () => window.clearTimeout(t);
  }, [slotCount, visibleKey]);
  const fillableStudents = room
    ? Array.from(room.remoteParticipants.values()).filter(
        (p) => !isTeacherParticipant(p, teacherSet) && !peerIds.includes(p.identity)
      ).length
    : 0;

  // Student videos window (during a share): only the tiles actually shown,
  // and the window is resized to exactly fit them (lib/peerWindow).
  const [winTileW, setWinTileW] = useState(PEER_WIN_TILE_W);
  const winCount = peerWindowTileCount({
    slots: slotCount,
    filled: Math.min(peerIds.length, slotCount - 1),
    connecting: settling ? fillableStudents : 0,
  });
  const winGrid = useMemo(() => peerWindowGrid(winCount, winTileW), [winCount, winTileW]);
  const [paneEl, setPaneEl] = useState<HTMLDivElement | null>(null);
  const setPaneRef = useCallback((el: HTMLDivElement | null) => {
    paneRef.current = el;
    setPaneEl(el);
  }, []);
  const fitRef = useRef<{ w: number; h: number; at: number; tries: number } | null>(null);
  useEffect(() => {
    if (!portal || !portalWindow || !paneEl) return;
    const pw = portalWindow;
    fitRef.current = null;
    const fit = () => {
      if (pw.closed) return;
      const r = paneEl.getBoundingClientRect();
      const w = Math.ceil(r.width);
      const h = Math.ceil(r.height);
      if (!w || !h) return;
      if (Math.abs(pw.innerWidth - w) <= 1 && Math.abs(pw.innerHeight - h) <= 1) {
        fitRef.current = { w, h, at: Date.now(), tries: 0 };
        return;
      }
      const prev = fitRef.current;
      const tries = prev && prev.w === w && prev.h === h ? prev.tries + 1 : 1;
      // The window manager may refuse an exact size: give up after a few tries.
      if (tries > 4) return;
      fitRef.current = { w, h, at: Date.now(), tries };
      const extraW = pw.innerWidth > 0 && pw.outerWidth > 0 ? Math.max(0, pw.outerWidth - pw.innerWidth) : 16;
      const extraH = pw.innerHeight > 0 && pw.outerHeight > 0 ? Math.max(0, pw.outerHeight - pw.innerHeight) : 72;
      try {
        pw.resizeTo(w + extraW, h + extraH);
      } catch {
        /* ignore */
      }
    };
    const onResize = () => {
      const last = fitRef.current;
      // The teacher dragged the window wider / narrower: scale the tiles to the
      // new width; the height then snaps to the tiles.
      if (last && Date.now() - last.at > 700 && Math.abs(pw.innerWidth - last.w) > 8) {
        setWinTileW(peerWindowTileWForWidth(winCount, pw.innerWidth));
        return;
      }
      window.setTimeout(fit, 120);
    };
    fit();
    const t1 = window.setTimeout(fit, 250);
    const t2 = window.setTimeout(fit, 1000);
    pw.addEventListener('load', fit);
    pw.addEventListener('resize', onResize);
    const RO = (pw as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver ?? ResizeObserver;
    const ro = RO ? new RO(() => fit()) : null;
    ro?.observe(paneEl);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      pw.removeEventListener('load', fit);
      pw.removeEventListener('resize', onResize);
      ro?.disconnect();
    };
  }, [portal, portalWindow, paneEl, winGrid.paneW, winGrid.paneH, winCount]);
  const L = portal ? winGrid : layout;
  const shownCells = portal ? cells.slice(0, winCount) : cells;

  const style: CSSProperties = portal
    ? { position: 'relative', left: 0, top: 0, width: 'max-content', height: 'auto', borderRadius: 0, border: 0 }
    : docked && dock
      ? { left: dock.left + PEER_DOCK_MARGIN, top: dock.top + PEER_DOCK_MARGIN }
      : pos
        ? { left: pos.x, top: pos.y }
        : { left: 12, top: PEER_TOP_RESERVE };
  if (!isMin && !portal) {
    // Size is the selected slot layout, even when some tiles are blank.
    style.width = layout.paneW;
    style.height = layout.paneH;
  }

  const pane = (
    <div
      ref={setPaneRef}
      className="peers-float-pane"
      role="region"
      data-slots={slotCount}
      data-minimized={isMin ? '1' : '0'}
      data-docked={docked ? '1' : '0'}
      style={style}
      aria-label={portal ? 'Student videos' : 'Class videos — drag the top bar to move'}
    >
      <div
        className="peers-float-header"
        {...(portal ? {} : handleProps)}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          if (floating && dock) dock_();
        }}
        title={docked ? 'Drag to float this panel' : 'Drag to move · double-click to dock'}
      >
        <span className="text-2xs font-semibold text-slate-200">
          <span aria-hidden className="text-slate-500">⠿</span>
          {isMin && <span className="ml-1 text-slate-400">{peerIds.length + 1} videos</span>}
        </span>
        <div className="flex items-center gap-1" data-no-drag>
          {dock && !portal && (
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
                  onSlotsChange?.(studentCapForSlots(n));
                }}
                aria-label={`Show ${n} videos`}
                title={`Show ${n} videos: you + ${n - 1} student${n - 1 === 1 ? '' : 's'}`}
              >
                {n}
              </button>
            ))}
          {!portal && (
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] font-bold text-slate-300 hover:bg-white/10"
            onClick={() => (sharingDock ? setShareMinimized((v) => !v) : setMinimized((v) => !v))}
            aria-label={isMin ? 'Expand class videos' : 'Minimize class videos'}
            title={isMin ? 'Expand' : 'Minimize'}
          >
            {isMin ? '▢' : '—'}
          </button>
          )}
        </div>
      </div>
      {!isMin && (
        <div
          className="peers-float-grid"
          data-slots={slotCount}
          style={{
            gridTemplateRows: `repeat(${L.rows}, ${L.tileH}px)`,
            ...(portal ? { gridTemplateColumns: `repeat(${L.cols}, ${L.tileW}px)` } : {}),
          }}
        >
          {shownCells.map((identity, i) => {
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
                  tileW={L.tileW}
                  tileH={L.tileH}
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
                    width: L.tileW,
                    height: L.tileH,
                    display: 'grid',
                    placeItems: 'center',
                    color: '#94a3b8',
                    fontSize: 10,
                    fontWeight: 650,
                  }}
                >
                  {settling && i - 1 - peerIds.length < fillableStudents ? 'Connecting…' : 'Off camera'}
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
                teacherPinned={pinnedIdentities.includes(identity)}
                onTogglePin={onTogglePin ? (on) => onTogglePin(identity, on) : undefined}
                tileW={L.tileW}
                tileH={L.tileH}
                alert={focusAlerts[identity]}
              />
            );
          })}
        </div>
      )}
    </div>
  );
  if (portal && portalWindow) {
    return (
      <SideWindowPortal win={portalWindow} title="Student videos">
        {pane}
      </SideWindowPortal>
    );
  }
  return pane;
}

function PeerCamTile({
  name,
  mediaTrack,
  speaking,
  pinned,
  tileW,
  tileH,
  mirror = false,
  alert,
  teacherPinned = false,
  onTogglePin,
}: {
  /** Student left fullscreen / switched away. */
  alert?: string;
  /** The teacher pinned this student (stays in the panel, no rotation). */
  teacherPinned?: boolean;
  onTogglePin?: (pinned: boolean) => void;
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
        <span className="flex min-w-0 items-center gap-1 truncate text-[10px] font-medium text-white">
          {teacherPinned && (
            <span className="shrink-0 text-amber-300" aria-label="Pinned" title="Pinned: stays in the panel">
              <IconPin size={10} />
            </span>
          )}
          <span className="truncate">{name}</span>
        </span>
        {pinned && <span className="shrink-0 text-[9px] text-brand-300">Speaking</span>}
      </div>
      {onTogglePin && (
        <button
          type="button"
          className={cn('peer-pin-btn', teacherPinned && 'is-pinned')}
          onClick={() => onTogglePin(!teacherPinned)}
          aria-pressed={teacherPinned}
          aria-label={teacherPinned ? `Unpin ${name}` : `Pin ${name} (keep in the panel)`}
          title={teacherPinned ? 'Unpin (back to rotation)' : 'Pin: keep this student in the panel'}
        >
          <IconPin size={12} />
        </button>
      )}
      {alert && (
        <span
          className="absolute left-1 top-1 rounded-full bg-amber-500 px-1.5 py-0.5 text-[9px] font-bold text-black shadow"
          title={alert}
        >
          {alert}
        </span>
      )}
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

const viewportW = () => (typeof window === 'undefined' ? 1280 : window.innerWidth);
const viewportH = () => (typeof window === 'undefined' ? 800 : window.innerHeight);

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
  }, [canPublishVideo, camDesired, previewTrack, localParticipant, room, isTeacher, permTick]);

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
              dtx: true,
              // RED re-sends every Opus frame (~2x audio bitrate). Worth it for
              // the one teacher voice; students hear each other, so N student
              // mics with RED cost every listener 2N streams of audio.
              red: isTeacher,
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
  const [screenOn, setScreenOn] = useState(false);
  const [chatUnread, setChatUnread] = useState(0);
  const [localCamStream, setLocalCamStream] = useState<MediaStream | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [hudChatOpen, setHudChatOpen] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);
  // Roster and Chat share the right-hand side: opening one closes the other so
  // they never stack on top of each other.
  const toggleChat = useCallback(() => {
    setChatOpen((v) => !v);
    setRosterOpen(false);
  }, []);
  const toggleRoster = useCallback(() => {
    setRosterOpen((v) => !v);
    setChatOpen(false);
  }, []);
  const openRoster = useCallback(() => {
    setRosterOpen(true);
    setChatOpen(false);
  }, []);
  /** Student left fullscreen (Esc, swipe, app switch): prompt, never kick. */
  const focus = useStudentFocus(code, !isTeacher);
  // No element fullscreen (iPhone Safari): same look, as a scroll-locked fixed page.
  usePseudoFullscreen(!isTeacher && focus.focusMode);
  const [camError, setCamError] = useState<string | null>(null);
  const [hudOpen, setHudOpen] = useState(false);
  const [hudNotice, setHudNotice] = useState('');
  /** Share tuned for a playing video (30 fps, motion) instead of slides. Remembered in this tab. */
  const [videoMode, setVideoModeState] = useState(() => {
    try {
      return sessionStorage.getItem('share_video_mode') === '1';
    } catch {
      return false;
    }
  });
  const videoModeRef = useRef(videoMode);
  /** Teacher roster search (name / SID). */
  const [rosterQuery, setRosterQuery] = useState('');
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
  /** Whole-screen share: blackout pipeline hiding the floating controls from the capture. */
  const maskRef = useRef<MaskPipeline | null>(null);
  /** The window the mask paints over (the attached PiP / pop-up). */
  const maskWindowRef = useRef<Window | null>(null);
  /** The raw capture track (the published one is the masked copy when maskRef is set). */
  const rawShareRef = useRef<MediaStreamTrack | null>(null);
  /** Published screen-share audio (tab / system audio), if the teacher ticked "Share audio". */
  const screenAudioRef = useRef<{ track: LocalAudioTrack; owner: { unpublishTrack: (t: LocalAudioTrack, stop?: boolean) => Promise<unknown> } } | null>(null);
  const [maskActive, setMaskActive] = useState(false);
  const [maskFallback, setMaskFallback] = useState<MaskFallback>('');
  /** Share controls start as the compact pill on every share. */
  const [hudCompact, setHudCompact] = useState(true);
  const { state, refresh } = useRoomState(code, 2000, room);
  /** Student layout: one design on every device; only sizes follow the viewport. */
  const viewport = useViewport();
  /** Student-camera cap chosen from the float, shown before the next poll confirms it. */
  const [sampleCap, setSampleCap] = useState<number | null>(null);
  const capQueue = useRef(Promise.resolve());
  /** Class panel size (2/4/6 tiles, teacher included); student cap = slots − 1. */
  const [panelSlots, setPanelSlots] = useState<PanelSlots | null>(() => {
    try {
      const v = sessionStorage.getItem(`peers_slots_${code.toUpperCase()}`);
      if (v === '2' || v === '4' || v === '6') return Number(v) as PanelSlots;
    } catch {
      /* ignore */
    }
    return null;
  });
  const panelCapSynced = useRef(false);
  const chatStopped = state?.status === 'ENDED' || !!state?.ended;
  const chatActive = (isTeacher ? chatOpen && !screenOn : chatOpen) || hudChatOpen;
  const myParticipantId = state?.me?.id ?? null;
  const chatStudents = (state?.admitted ?? [])
    .filter((a) => a.role === 'STUDENT')
    .map((a) => ({ id: a.id, displayName: a.displayName, sid: a.sid ?? null }));
  /** Teacher chat recipient, shared by the dock panel and the share HUD; it
   * stays on the chosen student after each send (Reply / hand chip set it). */
  const [chatTo, setChatTo] = useState<'all' | string>('all');
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
   * close the HUD. Never touches the
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
    shareSurfaceRef.current = '';
    setShareSurface('');
    maskWindowRef.current = null;
    closeAllSideWindows();
    maskRef.current?.stop();
    maskRef.current = null;
    try {
      rawShareRef.current?.stop();
    } catch {
      /* ignore */
    }
    rawShareRef.current = null;
    const screenAudio = screenAudioRef.current;
    screenAudioRef.current = null;
    if (screenAudio) {
      void screenAudio.owner.unpublishTrack(screenAudio.track, true).catch(() => undefined);
      safeStop(screenAudio.track);
    }
    setMaskActive(false);
    setMaskFallback('');
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
    maskWindowRef.current = surface && !surface.window.closed ? surface.window : null;
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
      maskWindowRef.current = null;
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
  // stale stage unless this tab is already sharing.
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
    // Entire-screen capture: only when the blackout mask is running, otherwise
    // the window would be recorded.
    const floatingOk = () =>
      shareControlsPlacement(shareSurfaceRef.current) === 'floating' || !!maskRef.current;
    if (!floatingOk()) {
      setHudNotice(MONITOR_SHARE_HINT);
      return;
    }
    setHudCompact(true);
    const pending = beginShareControls();
    void pending.then((surface) => {
      if (!shareWantedRef.current || !floatingOk()) {
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
      // The published track is the masked copy (no displaySurface) when masking.
      const kind = displaySurfaceOf(rawShareRef.current ?? pub?.track?.mediaStreamTrack);
      if (!kind || kind === shareSurfaceRef.current) return;
      shareSurfaceRef.current = kind;
      setShareSurface(kind);
      // Switched to the entire screen without a mask running: close the window.
      if (shareControlsPlacement(kind) === 'inline' && !maskRef.current) {
        // Side windows are ordinary windows: an unmasked entire-screen capture records them.
        closeAllSideWindows();
      }
      if (shareControlsPlacement(kind) === 'inline' && shareWindowRef.current && !maskRef.current) {
        attachShareSurface(null);
        setMaskFallback('unsupported');
      }
    };
    check();
    const iv = window.setInterval(check, 1500);
    return () => window.clearInterval(iv);
  }, [isTeacher, screenOn, localParticipant, attachShareSurface]);

  /**
   * Switch a running share between slides and video mode without
   * republishing: capture frame rate, content hint, degradation preference and
   * the per-layer bitrate / frame-rate caps (lib/videoQuality shareProfile).
   */
  const applyShareProfile = useCallback(
    async (on: boolean) => {
      if (!localParticipant) return;
      const profile = shareProfile(on);
      const lt = localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track as LocalVideoTrack | undefined;
      const raw = rawShareRef.current;
      if (raw && raw.readyState === 'live') {
        try {
          await raw.applyConstraints({ ...raw.getConstraints(), frameRate: profile.capture.frameRate });
        } catch (e) {
          console.warn('share frame rate', e);
        }
      }
      for (const t of [raw, lt?.mediaStreamTrack]) {
        try {
          if (t) t.contentHint = profile.contentHint;
        } catch {
          /* ignore */
        }
      }
      if (!lt) return;
      try {
        await lt.setDegradationPreference(profile.degradationPreference as RTCDegradationPreference);
      } catch {
        /* ignore */
      }
      const sender = lt.sender;
      if (!sender) return;
      try {
        const params = sender.getParameters();
        if (!params.encodings?.length) return;
        params.encodings = shareEncodingsFor(params.encodings, on);
        await sender.setParameters(params);
      } catch (e) {
        console.warn('share encodings', e);
      }
    },
    [localParticipant]
  );

  const setVideoMode = useCallback(
    (on: boolean) => {
      videoModeRef.current = on;
      setVideoModeState(on);
      try {
        sessionStorage.setItem('share_video_mode', on ? '1' : '0');
      } catch {
        /* ignore */
      }
      void applyShareProfile(on);
    },
    [applyShareProfile]
  );

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
    const streamPromise = captureScreen(videoModeRef.current);

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
    // Keep the first audio track (tab / system audio); drop any extras.
    const shareAudio = stream.getAudioTracks().find((t) => t.readyState === 'live') ?? null;
    const dropShareAudio = () =>
      stream.getAudioTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      });
    stream.getAudioTracks().forEach((track) => {
      if (track === shareAudio) return;
      try {
        track.stop();
      } catch {
        /* ignore */
      }
    });
    if (!media || media.readyState === 'ended') {
      dropShareAudio();
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
      media.contentHint = shareProfile(videoModeRef.current).contentHint;
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
    rawShareRef.current = media;
    setHudCompact(true);
    setMaskFallback('');
    let controlsReady: Promise<ShareControlSurface | null> = controlsPromise;
    let mask: MaskPipeline | null = null;
    if (shareControlsPlacement(surfaceKind) === 'inline') {
      // Entire screen: keep the floating controls only if every published
      // frame can have the window painted black (Chrome/Edge insertable
      // streams + known screen geometry). Otherwise close it now, before
      // anything is published.
      const early = await controlsPromise.catch(() => null);
      let fallback: MaskFallback = '';
      if (early) {
        const { width: fw, height: fh } = media.getSettings();
        const screens = maskPipelineSupported() ? await resolveScreenGeometry() : null;
        let pipPos = { x: 0, y: 0 };
        try {
          pipPos = { x: early.window.screenX, y: early.window.screenY };
        } catch {
          /* unreadable → stays 0,0 → untrusted */
        }
        if (!maskPipelineSupported()) fallback = 'unsupported';
        else if (
          !windowPositionsTrusted({
            pip: pipPos,
            opener: { x: window.screenX, y: window.screenY },
            ua: navigator.userAgent || '',
          })
        )
          fallback = 'position';
        else if (!screens) fallback = 'screens';
        else if (!fw || !fh || !candidateScreens(screens, { width: fw, height: fh }).length) fallback = 'unsafe';
        else {
          maskWindowRef.current = early.window;
          mask = startMaskPipeline(media, {
            // The toolbar plus any chat / roster / video side windows.
            getWindows: () => [maskWindowRef.current, ...sideWindows()],
            screens,
            onUnsafe: (win) => {
              // Frame already blacked out. A side window whose position can no
              // longer be read is closed on its own; the toolbar takes
              // everything with it.
              if (closeSideWindowObject(win)) {
                setHudNotice('A side window could not be hidden from the share, so it was closed.');
                return;
              }
              maskWindowRef.current = null;
              closeAllSideWindows();
              attachShareSurface(null);
              setMaskFallback('unsafe');
            },
          });
          if (!mask) fallback = 'unsupported';
        }
      }
      if (mask) {
        maskRef.current = mask;
        setMaskActive(true);
        controlsReady = Promise.resolve(early);
        await mask.ready;
      } else {
        maskWindowRef.current = null;
        early?.close();
        controlsReady = Promise.resolve(null);
        setMaskFallback(fallback || 'unsupported');
      }
    }

    shareWantedRef.current = true;
    try {
      const published = new LocalVideoTrack(mask ? mask.track : media, undefined, true);
      const { width: capW, height: capH } = media.getSettings();
      const simulcast = SCREEN_SHARE.simulcast && screenShareSimulcastFor(capW, capH);
      // Slides: text must stay sharp, so under CPU/bandwidth pressure drop
      // frames, not pixels. Video mode: the reverse (smooth 30 fps).
      const profile = shareProfile(videoModeRef.current);
      try {
        published.mediaStreamTrack.contentHint = profile.contentHint;
      } catch {
        /* ignore */
      }
      const shareOpts = (layered: boolean) => ({
        name: 'screen',
        source: Track.Source.ScreenShare,
        simulcast: layered,
        screenShareEncoding: profile.top,
        degradationPreference: profile.degradationPreference as RTCDegradationPreference,
        screenShareSimulcastLayers: layered
          ? SCREEN_SHARE.layers.map(
              (l) => new VideoPreset(l.width, l.height, profile.low.maxBitrate, profile.low.maxFramerate)
            )
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
      dropShareAudio();
      try {
        media.stop();
      } catch {
        /* ignore */
      }
      mask?.stop();
      maskRef.current = null;
      maskWindowRef.current = null;
      rawShareRef.current = null;
      setMaskActive(false);
      const controls = await controlsReady.catch(() => null);
      controls?.close();
      shareSurfaceRef.current = '';
      setShareSurface('');
      console.warn('screen share', e);
      setScreenOn(false);
      setHudNotice(screenShareErrorMessage(e));
      return;
    }

    // Screen audio rides as its own track (source screen_share_audio). Students
    // subscribe to every teacher track and RoomAudioRenderer plays it; their
    // own-mic rules are untouched. A failure here never stops the video share.
    if (shareAudio && shareAudio.readyState === 'live') {
      const audioTrack = new LocalAudioTrack(shareAudio, undefined, true);
      try {
        await enqueueLocalPublish(async () => {
          await localParticipant.publishTrack(audioTrack, {
            name: 'screen_audio',
            source: Track.Source.ScreenShareAudio,
            // Music / video sound: no DTX gaps, higher bitrate than speech.
            audioPreset: AudioPresets.music,
            dtx: false,
            red: false,
          });
        });
        if (shareWantedRef.current) {
          screenAudioRef.current = { track: audioTrack, owner: localParticipant };
        } else {
          await localParticipant.unpublishTrack(audioTrack, true).catch(() => undefined);
        }
      } catch (err) {
        console.warn('screen share audio', err);
        safeStop(audioTrack);
      }
    }

    const controls = await controlsReady.catch(() => null);
    // Switched to the entire screen while publishing, with no mask: same rule.
    if (controls && !mask && shareControlsPlacement(displaySurfaceOf(media)) === 'inline') {
      controls.close();
      attachShareSurface(null);
      setMaskFallback('unsupported');
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
    router.push(
      isTeacher ? '/teacher/dashboard' : studentHomePath(!!state?.me?.viaSchoolApp || isSchoolStudentTab())
    );
  }

  async function endClass() {
    if (!confirm('End class for everyone?')) return;
    await roomFetch(code, '/end', { method: 'POST' });
    room?.disconnect();
    onClassEnded();
    router.push('/teacher/dashboard');
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

  // Separate chat / roster / student-video windows beside the share toolbar:
  // only while the toolbar floats, and only when they are either not captured
  // (window / tab share) or painted black by the running whole-screen mask.
  useSideWindows();
  const sideWindowsAllowed =
    isTeacher && screenOn && !!shareMount && (shareControlsPlacement(shareSurface) === 'floating' || maskActive);
  const videosWin = sideWindowsAllowed ? sideWindow('videos') : null;
  useEffect(() => {
    if (!sideWindowsAllowed) closeSideWindow('videos');
  }, [sideWindowsAllowed]);
  function toggleVideosWindow() {
    if (sideWindow('videos')) {
      closeSideWindow('videos');
      return;
    }
    let slots: 2 | 4 | 6 = 4;
    try {
      const v = sessionStorage.getItem(`peers_slots_${code.toUpperCase()}`);
      if (v === '2' || v === '6') slots = Number(v) as 2 | 6;
    } catch {
      /* ignore */
    }
    const r = openSideWindow('videos', {
      anchor: shareWindowRef.current,
      requireTrustedPosition: !!maskRef.current,
      size: peerWindowOuterSize(slots),
    });
    if (!r.ok) {
      setHudNotice(
        r.reason === 'blocked'
          ? 'Pop-ups are blocked for this site. Allow pop-ups to see student videos beside the toolbar.'
          : 'The student videos window cannot be hidden from an entire-screen share on this system, so it stays closed. Share a window or tab to use it.'
      );
    }
  }

  // Waiting room toggle (per class session, saved on the server). Off admits
  // everyone waiting and lets new students straight in (still muted).
  const [waitingRoomOverride, setWaitingRoomOverride] = useState<boolean | null>(null);
  const waitingRoomOn = waitingRoomOverride ?? state?.waitingRoomOn ?? true;
  useEffect(() => {
    if (waitingRoomOverride !== null && state?.waitingRoomOn === waitingRoomOverride) setWaitingRoomOverride(null);
  }, [waitingRoomOverride, state?.waitingRoomOn]);
  async function setWaitingRoom(on: boolean) {
    setWaitingRoomOverride(on);
    const res = await roomFetch(code, '/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waitingRoomOn: on }),
    }).catch(() => null);
    if (!res?.ok) {
      setWaitingRoomOverride(null);
      setHudNotice('Could not change the waiting room.');
    } else {
      setHudNotice(on ? 'Waiting room on: you admit each student.' : 'Waiting room off: students enter directly (muted).');
    }
    refresh();
  }

  // One unit for the panel buttons and the header: on entry, size the panel
  // from the room's student cap (dashboard value) unless this tab already
  // chose one, then make the server cap match the panel (slots − 1) once.
  const serverCap = state?.maxVisibleVideos;
  useEffect(() => {
    if (!isTeacher || !serverCap) return;
    const slots = panelSlots ?? panelSlotsForCap(serverCap);
    if (!panelSlots) setPanelSlots(slots);
    if (panelCapSynced.current) return;
    panelCapSynced.current = true;
    if (serverCap !== studentCapForSlots(slots)) setStudentCameraCap(studentCapForSlots(slots));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTeacher, serverCap, panelSlots]);

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
  // Roster panel: students only (the teacher is not listed), raised hands
  // first by raise time, then pinned, then by name.
  const rosterStudents = sortRoster(
    (state?.admitted ?? [])
      .filter((p) => p.role === 'STUDENT')
      .map((p) => ({ ...p, handRaised: !!(p.handRaised || (state?.raisedHands ?? []).includes(p.id)) }))
  );
  const shownRoster = filterPeople(rosterStudents, rosterQuery);
  const shownWaiting = filterPeople(state?.waiting ?? [], rosterQuery);
  /** Raised hands, earliest first: shown in the chat panel so they stay in
   * sight while the roster is closed. */
  const raisedHands = rosterStudents
    .filter((p) => p.handRaised)
    .map((p) => ({ id: p.id, displayName: p.displayName }));
  // Teacher: raised hands and unread chat in the tab title, so they show in
  // the tab strip / taskbar while the teacher looks at the shared display.
  const handsN = isTeacher ? raisedHands.length : 0;
  const unreadN = isTeacher ? chatUnread : 0;
  useEffect(() => {
    if (!isTeacher || typeof document === 'undefined') return;
    const base = document.title.replace(/^\([^)]*\)\s*/, '');
    document.title = teacherTabTitle(base, handsN, unreadN);
  }, [isTeacher, handsN, unreadN]);
  useEffect(
    () => () => {
      if (typeof document !== 'undefined') document.title = document.title.replace(/^\([^)]*\)\s*/, '');
    },
    []
  );
  const focusAlertCount = countFocusAlerts((state?.admitted ?? []).filter((a) => a.role === 'STUDENT'));
  /** LiveKit identity → fullscreen alert label, for the Class panel tiles. */
  const focusByIdentity = useMemo(() => {
    const m: Record<string, string> = {};
    for (const a of state?.admitted ?? []) {
      if (a.role !== 'STUDENT' || !isFocusAlert(a.focus)) continue;
      const label = focusLabel(a.focus, a.focusIphone);
      if (label) m[a.livekitIdentity] = label;
    }
    return m;
  }, [state?.admitted]);

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

  /** Teacher pins / unpins a student's video (roster, class panel tile, share HUD). */
  async function togglePin(participantId: string, pinned: boolean) {
    try {
      const res = await roomFetch(code, '/pin-student', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ participantId, pinned }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setHudNotice((data as { error?: string }).error || `Could not change the pin (${res.status})`);
        return;
      }
      refresh();
    } catch {
      setHudNotice('Could not change the pin');
    }
  }
  const pinnedIdentities = useMemo(
    () =>
      (state?.admitted ?? [])
        .filter((p) => p.role === 'STUDENT' && p.pinned)
        .sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0))
        .map((p) => p.livekitIdentity),
    [state?.admitted]
  );
  const participantIdByIdentity = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of state?.admitted ?? []) m.set(p.livekitIdentity, p.id);
    return m;
  }, [state?.admitted]);

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
  // —— Student drawing on the shared screen (ShareDrawing.tsx, lib/drawLogic.ts) ——
  const drawActions = useDrawingActions(code);
  const drawHolder = state?.drawHolder ?? null;
  const sharingNow = isTeacher ? screenOn || stageMode === 'screen' : effectiveStage === 'screen';
  const [drawOverride, setDrawOverride] = useState<'off' | 'requested' | 'drawing' | null>(null);
  const serverDrawState: 'off' | 'requested' | 'drawing' = state?.me?.canDraw
    ? 'drawing'
    : state?.me?.drawRequested
      ? 'requested'
      : 'off';
  useEffect(() => {
    if (drawOverride !== null && drawOverride === serverDrawState) setDrawOverride(null);
  }, [drawOverride, serverDrawState]);
  const myDrawState = drawOverride ?? serverDrawState;
  async function toggleDraw() {
    if (isTeacher) return;
    const prev = myDrawState;
    if (prev === 'drawing') {
      setDrawOverride('off');
      const res = await roomFetch(code, '/draw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'release' }),
      }).catch(() => null);
      if (!res?.ok) setDrawOverride(null);
    } else {
      setDrawOverride(prev === 'requested' ? 'off' : 'requested');
      const err = await drawActions.request(prev !== 'requested');
      if (err) setDrawOverride(null);
    }
    refresh();
  }
  async function allowDrawing(participantId: string) {
    const err = await drawActions.allow(participantId);
    if (err) setHudNotice(err);
    refresh();
  }
  async function revokeDrawing(participantId?: string) {
    const err = await drawActions.revoke(participantId);
    if (err) setHudNotice(err);
    refresh();
  }
  async function clearDrawing() {
    const err = await drawActions.clear();
    if (err) setHudNotice(err);
  }
  // Teacher: a toast for each new request to draw (in this tab and in share controls).
  const drawRequesters = useMemo(
    () =>
      (state?.admitted ?? [])
        .filter((p) => p.role === 'STUDENT' && p.drawRequested)
        .sort((a, b) => (a.drawRequestedAt ?? 0) - (b.drawRequestedAt ?? 0)),
    [state?.admitted]
  );
  const seenDrawReq = useRef<Set<string>>(new Set());
  const [drawToast, setDrawToast] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    if (!isTeacher) return;
    const ids = new Set(drawRequesters.map((p) => p.id));
    const fresh = drawRequesters.find((p) => !seenDrawReq.current.has(p.id));
    seenDrawReq.current = ids;
    if (fresh) {
      setDrawToast({ id: fresh.id, name: fresh.displayName });
      setHudNotice(`${fresh.displayName} asks to draw on your screen. Allow in the roster.`);
    } else if (drawToast && !ids.has(drawToast.id)) {
      // Allowed, cancelled or revoked: the request notice is stale.
      setDrawToast(null);
      setHudNotice((n) => (n && n.includes(' asks to draw on your screen.') ? '' : n));
    }
  }, [isTeacher, drawRequesters, drawToast]);
  useEffect(() => {
    if (!drawToast) return;
    const t = window.setTimeout(() => setDrawToast(null), 12_000);
    return () => window.clearTimeout(t);
  }, [drawToast]);

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
    drawState: !isTeacher && sharingNow ? myDrawState : undefined,
    onToggleDraw: isTeacher ? undefined : () => void toggleDraw(),
  };
  const withDrawing = (node: ReactNode) => (
    <ShareDrawingProvider
      code={code}
      active={sharingNow}
      holder={drawHolder}
      myIdentity={state?.me?.livekitIdentity ?? localParticipant.identity}
      canDraw={!isTeacher && myDrawState === 'drawing' && !!state?.me?.canDraw}
      desktopInk={!!state?.desktopInk}
    >
      {node}
    </ShareDrawingProvider>
  );

  // —— Student path: always fullscreen stage + floating teacher cam + float chrome ——
  if (!isTeacher) {
    // teacherLive === false: the teacher's media connection is gone (dropped
    // mid-share, closed the tab). Redis may still say stage=screen until the
    // teacher returns, so do not show a stale "Teacher screen" stage.
    const teacherGone = teacherLive === false;
    const teacherHere = teacherIdentities.length > 0 && !teacherGone;
    const showTeacherScreen = effectiveStage === 'screen' && !teacherGone;
    const covered = needsCover(focus.status);
    const badge =
      showTeacherScreen
        ? 'Teacher screen'
        : teacherHere
          ? 'Teacher is in the room'
          : 'Waiting for teacher…';

    return withDrawing(
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

        {/* Left fullscreen or switched away: cover the class (audio keeps
            playing; teacher video and screen are not rendered underneath). */}
        {covered && (
          <button
            type="button"
            onClick={() => void focus.returnToFullscreen()}
            className="fixed inset-0 z-[90] flex flex-col items-center justify-center gap-3 bg-black px-6 text-center text-white"
            aria-label="Tap to return to fullscreen"
          >
            <IconScreen size={36} className="text-brand-300" />
            <span className="font-display text-xl font-semibold">Tap to return to fullscreen</span>
            <span className="max-w-sm text-sm text-slate-400">
              You are still in the class and can hear it. Your teacher can see that you left fullscreen.
            </span>
          </button>
        )}

        {/* Small portrait screens (any device): a hint only, never blocks taps or audio. */}
        {focus.portrait && viewport.w < 640 && showTeacherScreen && (
          <div className="pointer-events-none fixed inset-x-3 top-3 z-[70] rounded-xl border border-white/15 bg-black/70 px-3 py-2 text-center text-xs font-semibold text-white backdrop-blur">
            Rotate your phone to landscape for a bigger view
          </div>
        )}

        <div className="absolute inset-0 z-10">
          {covered ? null : showTeacherScreen ? (
            <TeacherScreenStage teacherIdentities={teacherIdentities} />
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

        {/* The floating teacher video, on every device (draggable, minimisable). */}
        {!covered && (
          <TeacherCameraFloat
            teacherIdentities={teacherIdentities}
            roomCode={code}
            selfName={displayName}
            selfStream={localCamStream}
            camOn={camOn}
          />
        )}

        {/* Student controls: a vertical panel on the right edge, on every device. */}
        <div className="stage-float-chrome is-rail" data-float-bound="right">
          <Controls
            {...controlsProps}
            variant="float"
            layout="rail"
            onToggleChat={() => {
              setChatOpen((v) => !v);
            }}
            chatOpen={chatOpen}
            chatUnread={chatUnread}
          />
        </div>

        <FloatingPanel
          title="Chat"
          storageKey="student_chat_v3"
          open={chatOpen}
          onClose={() => setChatOpen(false)}
          width={studentChatBox(viewport.w, viewport.h).width}
          height={studentChatBox(viewport.w, viewport.h).height}
          defaultPos={() => {
            const box = studentChatBox(window.innerWidth, window.innerHeight);
            return { x: box.x, y: box.y };
          }}
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
            compact={compactViewport(viewport.w, viewport.h)}
          />
        </FloatingPanel>
      </div>
    );
  }

  return withDrawing(
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
            onOpenRoster={screenOn ? undefined : openRoster}
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
            {isTeacher && focusAlertCount > 0 && (
              <Badge tone="warning" className="whitespace-nowrap">
                {focusAlertCount} not in fullscreen
              </Badge>
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
                <span title="Tiles in the Class panel, including you (the 2 / 4 / 6 buttons use the same count)">
                  {(() => {
                    const slots =
                      panelSlots ?? panelSlotsForCap(sampleCap ?? state?.maxVisibleVideos ?? 5);
                    const v = videosShown(visibles.length, slots);
                    return `${v.shown}/${v.total} videos shown`;
                  })()}
                </span>
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

      </header>
      {isTeacher && (
        <span className="sr-only" aria-live="polite">
          {waitingCount > 0
            ? `${waitingCount} ${waitingCount === 1 ? 'student is' : 'students are'} waiting to join`
            : ''}
        </span>
      )}

      {isTeacher && drawToast && (
        <div className="teacher-toast" role="status">
          <IconPen size={16} className="shrink-0 text-amber-300" />
          <span className="flex-1">
            <b>{drawToast.name}</b> asks to draw on your screen
          </span>
          <Button
            size="sm"
            onClick={() => {
              void allowDrawing(drawToast.id);
              setDrawToast(null);
            }}
          >
            Allow
          </Button>
          <button type="button" className="text-xs text-slate-400 hover:text-white" onClick={() => setDrawToast(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
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
                localShareSurface={shareSurface}
                onStopShare={() => void toggleScreen()}
                entireShareInfo={{
                  controlsInTab: !shareMount,
                  hands: raisedHands.length,
                }}
                localPreview={
                  <LocalPreview
                    stream={localCamStream}
                    label={displayName}
                    inSample={effectiveCanPublish}
                    showMayBeVisible={isTeacher}
                    hideSampleStatus={!isTeacher}
                    isTeacher={isTeacher}
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
              <div className="shrink-0 rounded-xl border border-amber-400/30 bg-amber-500/10 p-1.5" data-no-drag>
                <div className="flex items-center justify-between gap-2 px-1">
                  <h3 className="text-2xs font-semibold uppercase tracking-wider text-amber-200">
                    Waiting ({waitingCount})
                  </h3>
                  {waitingCount > 1 && (
                    <button
                      type="button"
                      className="roster-admit-all"
                      onClick={() => void admitStudents(undefined, true)}
                      aria-label={`Admit all ${waitingCount} waiting students`}
                      title="Admit everyone waiting"
                    >
                      <IconUserPlus size={12} />
                      All
                    </button>
                  )}
                </div>
                <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
                  {shownWaiting.map((p) => (
                    <li key={p.id} className="roster-row" title={rosterLabel(p)}>
                      <Avatar name={p.displayName} size="xs" />
                      <span className="roster-name">{p.displayName}</span>
                      {p.gradeDivision && <span className="roster-meta">{p.gradeDivision}</span>}
                      {p.late && <span className="roster-chip roster-chip-red">Late</span>}
                      <span className="roster-actions">
                        <RosterIconButton
                          label={`Admit ${p.displayName}`}
                          tone="warn"
                          onClick={() => void admitStudents([p.id])}
                        >
                          <IconUserPlus size={14} />
                        </RosterIconButton>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex shrink-0 flex-wrap items-center gap-2" data-no-drag>
              <Button size="sm" variant="warning" onClick={() => muteAllStudents(true)}>
                Mute all
              </Button>
              <Button size="sm" variant="secondary" onClick={() => muteAllStudents(false)}>
                Unmute all
              </Button>
              <button
                type="button"
                role="switch"
                aria-checked={waitingRoomOn}
                className={cn('waiting-toggle ml-auto', waitingRoomOn ? 'is-on' : 'is-off')}
                onClick={() => void setWaitingRoom(!waitingRoomOn)}
                aria-label={waitingRoomOn ? 'Waiting room on. Turn off to let students in directly' : 'Waiting room off. Turn on to admit students yourself'}
                title={
                  waitingRoomOn
                    ? 'Waiting room on: you admit each student. Click to turn off (admits everyone waiting).'
                    : 'Waiting room off: students enter directly, muted. Click to turn on.'
                }
              >
                <IconDoor size={13} />
                <span>{waitingRoomOn ? 'Waiting room' : 'Direct entry'}</span>
              </button>
            </div>
            <label className="roster-search shrink-0" data-no-drag>
              <IconSearch size={13} aria-hidden />
              <input
                type="search"
                className="roster-search-input"
                placeholder="Search name or SID…"
                value={rosterQuery}
                onChange={(e) => setRosterQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setRosterQuery('');
                }}
                aria-label="Search students"
              />
              {rosterQuery.trim() && (
                <span className="chat-search-count">
                  {shownRoster.length}/{rosterStudents.length}
                </span>
              )}
            </label>
            <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto" data-no-drag>
              {rosterStudents.length === 0 && (
                <EmptyState
                  icon={<IconUsers size={22} />}
                  title="No students yet"
                  description="Admitted students will show up in this roster."
                  className="py-6"
                />
              )}
              {rosterStudents.length > 0 && shownRoster.length === 0 && (
                <li className="py-4 text-center text-2xs text-slate-400">No student matches “{rosterQuery.trim()}”.</li>
              )}
              {shownRoster.map((p) => {
                const raised = !!p.handRaised;
                const focus = focusLabel(p.focus, p.focusIphone);
                return (
                  <li
                    key={p.id}
                    className={cn('roster-row', (raised || p.drawRequested || p.drawing) && 'roster-row-raised')}
                    title={rosterLabel(p)}
                  >
                    {(p.drawing || p.drawRequested) && (
                      <span
                        className={cn('roster-hand', p.drawing && 'text-sky-300')}
                        title={p.drawing ? 'Drawing on your screen' : 'Asks to draw'}
                        aria-label={p.drawing ? 'Drawing on your screen' : 'Asks to draw'}
                      >
                        <IconPen size={13} />
                      </span>
                    )}
                    {raised && (
                      <span className="roster-hand" title="Hand raised" aria-label="Hand raised">
                        <IconHand size={13} />
                      </span>
                    )}
                    <Avatar name={p.displayName} size="xs" />
                    <span className="roster-name">{p.displayName}</span>
                    {p.gradeDivision && <span className="roster-meta">{p.gradeDivision}</span>}
                    {focus && (
                      <span
                        className={cn('roster-chip', isFocusAlert(p.focus) ? 'roster-chip-warn' : '')}
                        title={focus}
                      >
                        {focus}
                      </span>
                    )}
                    {p.late && <span className="roster-chip roster-chip-red">Late</span>}
                    <span className="roster-actions">
                      <RosterIconButton
                        label={p.mutedByTeacher ? `Unmute ${p.displayName}` : `Mute ${p.displayName}`}
                        tone={p.mutedByTeacher ? 'warn' : 'plain'}
                        pressed={!!p.mutedByTeacher}
                        onClick={() => muteStudent(p.id, !p.mutedByTeacher)}
                      >
                        {p.mutedByTeacher ? <IconMicOff size={14} /> : <IconMic size={14} />}
                      </RosterIconButton>
                      <RosterIconButton
                        label={p.pinned ? `Unpin ${p.displayName}'s video` : `Pin ${p.displayName}'s video`}
                        tone={p.pinned ? 'on' : 'plain'}
                        pressed={!!p.pinned}
                        onClick={() => void togglePin(p.id, !p.pinned)}
                      >
                        <IconPin size={13} />
                      </RosterIconButton>
                      {raised && (
                        <RosterIconButton
                          label={`Lower ${p.displayName}'s hand`}
                          tone="warn"
                          onClick={() => void lowerHand(p.id)}
                        >
                          <IconHandDown size={14} />
                        </RosterIconButton>
                      )}
                      {p.drawing ? (
                        <button type="button" className="roster-chip roster-chip-red" onClick={() => void revokeDrawing(p.id)}>
                          Revoke
                        </button>
                      ) : p.drawRequested ? (
                        <button type="button" className="roster-chip roster-chip-warn" onClick={() => void allowDrawing(p.id)}>
                          Allow
                        </button>
                      ) : null}
                    </span>
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
            chatUnread > 0 || raisedHands.length > 0 ? (
              <span className="inline-flex items-center gap-1">
                {raisedHands.length > 0 && (
                  <span
                    className="inline-flex items-center gap-0.5 rounded-full bg-amber-500 px-1.5 text-[9px] font-bold text-white"
                    title={`${raisedHands.length} raised ${raisedHands.length === 1 ? 'hand' : 'hands'}`}
                  >
                    <IconHand size={9} />
                    {raisedHands.length}
                  </span>
                )}
                {chatUnread > 0 && (
                  <span className="rounded-full bg-brand-500 px-1.5 text-[9px] font-bold text-white">
                    {chatUnread > 9 ? '9+' : chatUnread}
                  </span>
                )}
              </span>
            ) : null
          }
        >
          <ChatView
            thread={chatThread}
            isTeacher
            myParticipantId={myParticipantId}
            students={chatStudents}
            to={chatTo}
            onToChange={setChatTo}
            raisedHands={raisedHands}
            onLowerHand={(id) => void lowerHand(id)}
          />
        </FloatingPanel>
      </div>

      <TeacherPeersFloat
        roomCode={code}
        teacherIdentities={teacherIdentities}
        visibleIdentities={visibles}
        selfName={displayName}
        selfStream={localCamStream}
        slots={panelSlots}
        onSlotsChange={(studentSlots) => {
          setPanelSlots(panelSlotsForCap(studentSlots));
          void setStudentCameraCap(studentSlots);
        }}
        dock={dockArea}
        sharing={shareLayout}
        onDockSpace={onDockSpace}
        focusAlerts={focusByIdentity}
        pinnedIdentities={pinnedIdentities}
        portalWindow={videosWin}
        onTogglePin={(identity, on) => {
          const id = participantIdByIdentity.get(identity);
          if (id) void togglePin(id, on);
        }}
      />

      {/* Share controls: in the floating window for window/tab captures; in
          this tab (draggable dock) for entire-screen captures or when no
          window could be opened. Never both. */}
      {isTeacher && screenOn && (
        <ShareHudSlot
          floating={!!shareMount}
          compact={hudCompact}
          popOut={
            shareControlsPlacement(shareSurface) === 'inline' && !maskActive
              ? undefined
              : () => reopenShareControls()
          }
          hint={
            shareControlsPlacement(shareSurface) === 'inline' && !maskActive
              ? maskFallback === 'screens'
                ? MONITOR_SCREENS_HINT
                : maskFallback === 'unsafe'
                  ? MONITOR_UNSAFE_HINT
                  : maskFallback === 'position'
                    ? MONITOR_POSITION_HINT
                    : MONITOR_SHARE_HINT
              : undefined
          }
          action={
            maskFallback === 'screens' ? (
              <button type="button" className="share-inline-btn" onClick={() => void requestScreenDetails()}>
                Allow
              </button>
            ) : undefined
          }
        >
          <TeacherShareHud
            videoMode={videoMode}
            onVideoModeChange={setVideoMode}
            focusAlertCount={focusAlertCount}
            host={shareMount}
            hostWindow={shareWindow}
            inline={!shareMount}
            compact={hudCompact}
            onCompactChange={setHudCompact}
            admitted={state?.admitted ?? []}
            waiting={(state?.waiting ?? []).map((w) => ({
              id: w.id,
              displayName: rosterLabel(w),
              role: 'STUDENT',
              sid: w.sid ?? null,
            }))}
            waitingCount={waitingCount}
            onAdmit={(id) => void admitStudents([id])}
            onAdmitAll={() => void admitStudents(undefined, true)}
            teacherMicOn={micOn && !effectiveMuted}
            onToggleTeacherMic={() => setMicOn((v) => !v)}
            teacherCamOn={camOn}
            onToggleTeacherCam={() => setCamOn((v) => !v)}
            sideWindowsAllowed={sideWindowsAllowed}
            sideWindowsNeedTrust={maskActive}
            videosOpen={!!videosWin}
            onToggleVideos={sideWindowsAllowed ? toggleVideosWindow : undefined}
            onStopSharing={() => void toggleScreen()}
            onMuteStudent={(id, muted) => void muteStudent(id, muted)}
            onMuteAll={(muted) => void muteAllStudents(muted)}
            onLowerHand={(id) => void lowerHand(id)}
            onTogglePin={(id, on) => void togglePin(id, on)}
            drawHolderName={drawHolder?.name ?? null}
            onAllowDraw={(id) => void allowDrawing(id)}
            onRevokeDraw={(id) => void revokeDrawing(id)}
            onClearDrawing={() => void clearDrawing()}
            drawPreview={sideWindowsAllowed && !!shareMount ? 'video' : 'strokes'}
            chatUnread={chatUnread}
            onChatOpenChange={setHudChatOpen}
            chat={
              <ChatView
                thread={chatThread}
                isTeacher
                myParticipantId={myParticipantId}
                students={chatStudents}
                to={chatTo}
                onToChange={setChatTo}
                raisedHands={raisedHands}
                onLowerHand={(id) => void lowerHand(id)}
              />
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
          onToggleChat={screenOn ? undefined : toggleChat}
          chatOpen={chatOpen}
          chatUnread={chatUnread}
          onToggleRoster={screenOn ? undefined : toggleRoster}
          rosterOpen={rosterOpen}
          rosterBadge={waitingCount}
          handsCount={raisedHands.length}
        />
      </footer>
    </div>
  );
}

/**
 * Ask for the Window Management permission (multi-monitor screen positions),
 * from a click. Used before the next whole-screen share.
 */
async function requestScreenDetails() {
  const w = window as unknown as { getScreenDetails?: () => Promise<unknown> };
  try {
    await w.getScreenDetails?.();
  } catch {
    /* denied */
  }
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
        {n === 1 ? 'Admit' : `Admit ${shortName(first.displayName)}`}
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
  compact,
  popOut,
  hint,
  action,
  children,
}: {
  floating: boolean;
  compact?: boolean;
  popOut?: () => void;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  if (floating) return <>{children}</>;
  return (
    <InlineShareDock onPopOut={popOut} hint={hint} compact={compact} action={action}>
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
  /** School-app student (home is /student); null until known. */
  const [schoolStudent, setSchoolStudent] = useState<boolean | null>(null);
  const [displayName, setDisplayName] = useState('You');
  const [canPublishVideo, setCanPublishVideo] = useState(false);
  /**
   * This tab lost the class to another connection:
   * - 'device': LiveKit DUPLICATE_IDENTITY (same account opened the class on
   *   another device or tab). No auto-reconnect, or the two would keep
   *   kicking each other; "Use this device instead" takes it back on purpose.
   * - 'session': this browser's staff session was replaced or revoked.
   * Rendering the notice unmounts LiveKitRoom, which disconnects it.
   */
  const [handoff, setHandoff] = useState<null | 'device' | 'session'>(null);
  const [takingBack, setTakingBack] = useState(false);

  useEffect(() => {
    const onEnded = () => {
      setHandoff('session');
      setTokenData(null);
    };
    window.addEventListener(SESSION_ENDED_EVENT, onEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onEnded);
  }, []);

  const onDisconnected = useCallback(
    (reason?: DisconnectReason) => {
      if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
        setHandoff((h) => h ?? 'device');
        setTokenData(null);
        window.dispatchEvent(new Event(SESSION_CHECK_EVENT));
      } else if (reason === DisconnectReason.PARTICIPANT_REMOVED && isTeacher) {
        // Only a newer sign-in removes the teacher from the SFU (sessionKick).
        setHandoff((h) => h ?? 'device');
        setTokenData(null);
        window.dispatchEvent(new Event(SESSION_CHECK_EVENT));
      }
    },
    [isTeacher]
  );

  /**
   * "Home" from the class-ended screen: teachers → dashboard, school-app
   * students → /student (their next class), guests → /. When the room had
   * already ended on load we never saw `me`, so ask whether a school-app
   * session exists.
   */
  const goHomeAfterEnd = useCallback(async () => {
    if (isTeacher) return router.push('/teacher/dashboard');
    let school = !!schoolStudent || isSchoolStudentTab();
    if (!school) {
      // Ended before we saw `me`, or an older tab: ask for a school session.
      try {
        school = (await fetch('/api/student/check', { cache: 'no-store' })).ok;
      } catch {
        school = false;
      }
    }
    router.push(studentHomePath(school));
  }, [isTeacher, schoolStudent, router]);

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

    if (state.me?.viaSchoolApp) markSchoolStudentTab();
    setSchoolStudent(!!state.me?.viaSchoolApp || isSchoolStudentTab());
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

  /** "Use this device instead": deliberately take the class back (kicks the other connection). */
  const takeBack = useCallback(async () => {
    setTakingBack(true);
    const back = `/classroom/${code}`;
    if (handoff === 'session') {
      window.location.href = loginHref('signed_in_elsewhere', back);
      return;
    }
    try {
      const res = await fetch('/api/auth/status', { cache: 'no-store' });
      const data = (await res.json().catch(() => ({}))) as { role?: string | null; reason?: unknown };
      if (isEndedReason(data.reason) || (isTeacher && !data.role)) {
        // Replaced session: a fresh sign-in is needed, then straight back here.
        window.location.href = loginHref(isEndedReason(data.reason) ? data.reason : 'signed_in_elsewhere', back);
        return;
      }
    } catch {
      /* offline: the token request below reports it */
    }
    setHandoff(null);
    setTakingBack(false);
    void load();
  }, [code, load, handoff, isTeacher]);

  // NOTE: room state is polled by useRoomState() inside RoomInner (2s, slower once server pushes are live), which
  // also surfaces the ENDED transition via onClassEnded(). A second /state
  // poller used to live here and doubled the load on the hottest endpoint in the
  // app for no behavioural gain — the props below are initial values that
  // effectiveCanPublish / effectiveMuted immediately override from `state`.

  if (handoff) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6">
        <div className="max-w-md rounded-2xl border border-white/10 bg-surface-1 p-8 text-center shadow-lift">
          <p className="font-display text-2xl font-semibold tracking-tight">
            {handoff === 'session' ? 'You were signed in on another device' : 'Class continued on another device'}
          </p>
          <p className="mt-2 text-sm text-slate-400">
            {handoff === 'session'
              ? 'This device was disconnected from the class because your account signed in somewhere else.'
              : 'This class was opened with your account on another device or tab, so this one was disconnected. The class itself carries on there.'}
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button onClick={() => void takeBack()} disabled={takingBack}>
              {takingBack ? 'Checking…' : 'Use this device instead'}
            </Button>
            <Button variant="secondary" onClick={() => router.push(isTeacher ? '/teacher/dashboard' : '/')}>
              {isTeacher ? 'Dashboard' : 'Home'}
            </Button>
          </div>
        </div>
      </main>
    );
  }

  if (classEnded) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6">
        <div className="max-w-md rounded-2xl border border-white/10 bg-surface-1 p-8 text-center shadow-lift">
          <p className="font-display text-2xl font-semibold tracking-tight">Class ended</p>
          <p className="mt-2 text-sm text-slate-400">
            Your teacher has ended this class. You can leave this page.
          </p>
          <Button className="mt-6" variant="secondary" onClick={() => void goHomeAfterEnd()}>
            {isTeacher ? 'Dashboard' : 'Home'}
          </Button>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6">
        <p className="text-danger-fg">{error}</p>
        <Button variant="secondary" onClick={() => void goHomeAfterEnd()}>
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
        // Phones (touch + small screen) count CSS pixels 1:1, so a phone
        // receives the 720p share layer (≈1 Mbps in video mode) instead of
        // the top layer its device-pixel ratio would ask for; laptops and
        // tablets showing the share large get the top layer.
        adaptiveStream: { pauseVideoInBackground: false, pixelDensity: subscriberPixelDensity() },
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
      onDisconnected={onDisconnected}
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
  if (p.viaSchoolApp && !p.onTimetable) bits.push(p.adHocClass ? 'outside class audience' : 'not on timetable');
  if (!p.viaSchoolApp) bits.push('guest');
  return bits.join(' · ');
}

/** Fullscreen / focus status under a student's name (teacher roster). */
function FocusChip({ focus, iphone }: { focus?: import('@/lib/focusStatus').FocusStatus; iphone?: boolean }) {
  const label = focusLabel(focus, iphone);
  if (!label) return null;
  return (
    <span
      className={cn(
        'mt-0.5 inline-flex rounded px-1 text-2xs font-semibold',
        isFocusAlert(focus) ? 'bg-amber-500/20 text-amber-200' : 'bg-white/10 text-slate-300'
      )}
    >
      {label}
    </span>
  );
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
          // Ad-hoc classes are not on the timetable: matching students need no tag.
          info.adHocClass ? null : (
            <span className="rounded bg-emerald-500/15 px-1 font-semibold text-emerald-200">On timetable</span>
          )
        ) : info.adHocClass ? (
          <span className="rounded bg-amber-500/15 px-1 font-semibold text-amber-100">Outside class audience</span>
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

/** Small square icon button for roster rows, with tooltip and aria-label. */
function RosterIconButton({
  label,
  onClick,
  children,
  tone = 'plain',
  pressed,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  tone?: 'plain' | 'warn' | 'on';
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn('roster-icon-btn', tone !== 'plain' && `roster-icon-btn-${tone}`)}
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
    >
      {children}
    </button>
  );
}

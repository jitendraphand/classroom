'use client';

import {
  classEndedCopy,
  classSummaryFacts,
  finishCopy,
  finishFromState,
  type ClassSummaryRow,
  type FinishReason,
} from '@/lib/classFinish';
import {
  classEndedNoted,
  noteClassEnded,
  onceCached,
  preferFinish,
  verdictFromProbe,
  type ProbeBody,
  type ProbeHit,
} from '@/lib/classEnded';
import { distinctConnectedStudents } from '@/lib/connectedStudents';
import { freshTakeovers, takeoverToastText } from '@/lib/deviceTakeover';
import { useMicDuck } from './useMicDuck';
import { CLASS_FINISHED_EVENT } from '@/lib/classFinishEvent';
import dynamic from 'next/dynamic';
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
  LocalAudioTrack,
  RoomEvent,
  ConnectionQuality,
  ConnectionState,
  DisconnectReason,
  AudioPresets,
  VideoPreset,
  type LocalTrackPublication,
  type Participant,
  type RemoteParticipant,
  type TrackPublication,
} from 'livekit-client';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { keepShareAudio } from '@/lib/audioPolicy';
import {
  STUCK_RECONNECT_MS,
  classroomReconnectPolicy,
  connectRetryDelayMs,
  isOwnStaleDuplicate,
  rejoinDelayMs,
  rejoinOutcome,
  shouldAutoRejoin,
} from '@/lib/rejoinPolicy';
import { SESSION_CHECK_EVENT, SESSION_ENDED_EVENT, isEndedReason, loginHref } from '@/lib/sessionClient';
import { useRoomState, type RosterInfo } from '@/hooks/useRoomState';
import { compactViewport, studentChatBox, usePseudoFullscreen, useViewport } from '@/hooks/useStudentLayout';
import { shortName } from '@/lib/displayNames';
import { Controls } from './Controls';
import { LocalPreview } from './LocalPreview';
import { DrawOverlay, ShareDrawingProvider, useDrawingActions, useShareDrawing } from './ShareDrawing';
import { TeacherInkOverlay, TeacherInkProvider } from './TeacherInk';
import { WhiteboardMeetingBar } from './MeetingBar';
import { SHARE_POSITION_NOTICE_KEY, inlineShareDockHint, sharePositionNoticeOpen } from '@/lib/shareChrome';
import { ZoomPanSurface } from './ZoomPanSurface';
import { WhiteboardHost, WhiteboardViewer, hasSavedBoard } from './Whiteboard';
import { useChatThread } from './chatThread';
// Chat UI loads on first open (the thread hook above keeps unread counts live).
const ChatView = dynamic(() => import('./Chat').then((m) => m.ChatView), { ssr: false });
import { useStudentFocus } from './useStudentFocus';
import { countFocusAlerts, focusLabel, fullscreenGate, fullscreenGateText, isFocusAlert } from '@/lib/focusStatus';
import { FloatingPanel } from './FloatingPanel';
import { WB_TOOL_CLEAR_PX, shareControlsPlacement, showLocalSharePreview } from '@/lib/floatGeometry';
import { isRosterDropped, selectTeacherVideos, videoHidden } from '@/lib/droppedVideos';
import { candidateScreens, surfaceFromTrack, windowPositionsTrusted } from '@/lib/screenMask';
import { maskPipelineSupported, resolveScreenGeometry, startMaskPipeline, type MaskPipeline } from '@/lib/screenMaskPipeline';
import {
  InlineShareDock,
  TeacherShareHud,
  beginShareControls,
  preopenShareControls,
  type ShareControlSurface,
  type TeacherShareHudProps,
} from './TeacherShareHud';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { pageTitle, useTabTitle } from '@/hooks/useDocumentTitle';
import { PageLoading } from '@/components/ui/Skeleton';
import {
  IconDoor,
  IconHand,
  IconHandDown,
  IconMic,
  IconMicOff,
  IconPen,
  IconPin,
  IconStar,
  IconScreen,
  IconSearch,
  IconUserPlus,
  IconUsers,
  IconVideo,
} from '@/components/ui/Icons';
import {
  panelSlotsForCap,
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
import { ROSTER_PAGE, rosterWindow } from '@/lib/rosterWindow';
import { peerWindowOuterSize } from '@/lib/peerWindow';
import {
  parseMediaProfile,
  screenShare,
  screenShareSimulcastFor,
  setMediaProfile,
  shareEncodingsFor,
  shareProfile,
  studentCamera,
  SHARE_CODEC,
  shareUsesVp9,
} from '@/lib/videoQuality';
import { effectiveCamWanted } from '@/lib/camOnDemand';
import { nextDataSaver } from '@/lib/dataSaver';
import { useDataSaver } from '@/hooks/useDataSaver';
import { TeacherMediaDemand } from './TeacherMediaDemand';
import { ClassInfoButton } from './ClassInfoButton';
import { FeedbackForm } from './FeedbackForm';
import { SpotlightFloat } from './SpotlightFloat';
import { clientConnectDelayMs, isNegotiationError } from '@/lib/joinPacingLogic';
import {
  nextStudentVideoMode,
  parseStudentVideoMode,
  studentVideoModeLabel,
  studentVideoModeShortLabel,
  type StudentVideoMode,
} from '@/lib/studentVideoMode';
import {
  HEARTBEAT_INTERVAL_MS,
  heartbeatPeriodMs,
  LOST_GRACE_MS,
  STUDENT_GONE_GRACE_MS,
  nextPresencePhase,
  type PresencePhase,
} from '@/lib/studentPresenceLogic';

/** Wait the server-assigned connect slot (lib/joinPacingLogic). */
import { CameraErrorBanner, SelectivePublisher } from './SelectivePublisher';
import { StudentMediaPrivacy } from './StudentMediaPrivacy';
import { TeacherCameraFloat, TeacherStageCamera } from './TeacherCameraFloat';
import { TeacherPeersFloat } from './TeacherPeersFloat';
import { enqueueLocalPublish, safeStop } from './localPublish';
import { primeVoiceAudio } from '@/lib/audio/voiceProcessor';
import { isTeacherParticipant, useHasTeacherScreen, useTeacherLive } from './participantRoles';

function sleepConnectDelay(body: unknown): Promise<void> {
  const ms = clientConnectDelayMs(body);
  return ms > 0 ? new Promise((r) => window.setTimeout(r, ms)) : Promise.resolve();
}

type TokenPayload = {
  token: string;
  url: string;
  identity: string;
  canPublishVideo: boolean;
  visibleIdentities: string[];
  mutedByTeacher: boolean;
  /** Server MEDIA_PROFILE (lib/videoQuality): applied before anything is published. */
  mediaProfile?: string;
};

function ParticipantGrid({
  isTeacher,
  localPreview,
  teacherIdentities,
  visibleIdentities: _visibleIdentities,
  localShareSurface = '',
  onStopShare,
  entireShareInfo,
  hiddenIdentities = [],
  onShareScreen,
  onPrepareShare,
  onOpenWhiteboard,
}: {
  /** Teacher, nothing shared: quick starts shown on the empty stage. */
  onShareScreen?: () => void;
  onPrepareShare?: () => void;
  onOpenWhiteboard?: () => void;
  entireShareInfo?: EntireShareInfo;
  /** What this teacher tab is capturing; decides whether the local share may be previewed. */
  localShareSurface?: string;
  onStopShare?: () => void;
  visibleIdentities: string[];
  isTeacher: boolean;
  localPreview: ReactNode;
  teacherIdentities: string[];
  /** Students the roster has already dropped. Their tracks are not shown. */
  hiddenIdentities?: readonly string[];
}) {
  void _visibleIdentities;
  const hidden = new Set(hiddenIdentities);
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: false },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: true }
  );

  const teacherSet = useMemo(() => new Set(teacherIdentities), [teacherIdentities]);

  const screenShares = tracks.filter((t) => {
    if (t.source !== Track.Source.ScreenShare) return false;
    if (hidden.has(t.participant.identity)) return false;
    // Only the teacher shares a screen (students have no screen-share grant);
    // never render a share from anyone else.
    if (t.participant.isLocal) return isTeacher;
    return isTeacherParticipant(t.participant, teacherSet);
  });

  const cameras = tracks.filter((t) => {
    if (t.source !== Track.Source.Camera || t.participant.isLocal) return false;
    if (hidden.has(t.participant.identity)) return false;
    // Only teacher remote videos. Students never see other students; the
    // teacher sees student cameras once, in the docked Class panel
    // (TeacherPeersFloat, with the 2/4/6 mosaic), not again on the stage.
    return isTeacherParticipant(t.participant, teacherSet);
  });

  const hasScreen = screenShares.length > 0;

  if (!hasScreen && cameras.length === 0) {
    // Teacher: until a share, the stage offers the two ways to fill it; the
    // teacher's own camera preview lives only in the docked Class panel.
    if (isTeacher)
      return (
        <div className="stage-empty flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="max-w-sm text-center">
            <p className="font-semibold text-white">Nothing is shared yet</p>
            <p className="mt-1 text-sm text-slate-400">Share your screen or open the whiteboard to fill this space for everyone.</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {onShareScreen && (
                <Button onPointerDown={onPrepareShare} onClick={onShareScreen}>
                  Share screen
                </Button>
              )}
              {onOpenWhiteboard && (
                <Button variant="secondary" onClick={onOpenWhiteboard}>
                  Open whiteboard
                </Button>
              )}
            </div>
          </div>
        </div>
      );
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
        {d.holder ? `${d.holder.name} ${d.holder.name.includes(', ') ? 'are' : 'is'} drawing` : 'Student drawing'} (what students see over your screen)
      </p>
      <div className="draw-preview" style={{ aspectRatio: String(aspect) }}>
        <DrawOverlay aspect={aspect} interactive={false} />
      </div>
      <div className="relative z-10 mt-2 flex flex-wrap justify-center gap-2" data-testid="share-draw-actions">
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
            Revoke {d.holder.name.includes(', ') ? 'all' : d.holder.name}
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
    <div
      className="video-tile relative flex h-full min-h-0 w-full items-center justify-center overflow-hidden bg-ink-950 p-4"
      style={controlsInTab ? { paddingTop: '5.5rem', paddingBottom: '6.5rem' } : undefined}
    >
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
        <TeacherInkOverlay interactive={t.participant.isLocal} />
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

export function TeacherScreenStage({ teacherIdentities, zoomable = false, drawing = false }: { teacherIdentities: string[]; zoomable?: boolean; drawing?: boolean }) {
  const tracks = useTracks(
    [{ source: Track.Source.ScreenShare, withPlaceholder: false }],
    { onlySubscribed: true }
  );
  const teacherSet = useMemo(() => new Set(teacherIdentities), [teacherIdentities]);
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
          {(() => {
            const content = (
              <div className="relative h-full w-full">
                {t.publication?.track ? (
                  <VideoTrack trackRef={t} className="h-full w-full object-contain" />
                ) : (
                  <div className="flex h-full items-center justify-center text-slate-400">No screen</div>
                )}
                {/* Students' drawing (and the allowed student's drawing surface). */}
                <DrawOverlay />
                <TeacherInkOverlay interactive={false} />
              </div>
            );
            // Students: local pinch / wheel zoom (one finger draws while drawing is allowed).
            return zoomable ? <ZoomPanSurface panWithOneFinger={!drawing}>{content}</ZoomPanSurface> : <div className="relative h-full w-full">{content}</div>;
          })()}
        </div>
      ))}
    </div>
  );
}

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
    video: { ...screenShare().capture, ...shareProfile(videoMode).capture },
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

/** A share parked behind the whiteboard is really stopped after this long. */
const PARK_MAX_MS = 20 * 60_000;

function screenCaptureLive(pub?: LocalTrackPublication | null): boolean {
  const media = pub?.track?.mediaStreamTrack;
  return !!media && media.readyState !== 'ended';
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
  onFinished,
}: {
  code: string;
  isTeacher: boolean;
  canPublishVideo: boolean;
  mutedByTeacher: boolean;
  visibleIdentities: string[];
  displayName: string;
  onVisibilityChange: (v: boolean) => void;
  /** The class ended; teachers get that session's summary on the finished screen. */
  onClassEnded: (classSessionId: string | null) => void;
  /** Student: the class view stops for good (left / ended / removed / another device). */
  onFinished: (r: FinishReason) => void;
}) {
  const router = useRouter();
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const [studentVideoMode, setStudentVideoMode] = useState<StudentVideoMode>(() => {
    if (typeof window === 'undefined') return 'both';
    try {
      return parseStudentVideoMode(sessionStorage.getItem(`student_video_mode_${code}`));
    } catch {
      return 'both';
    }
  });
  useEffect(() => {
    if (isTeacher) return;
    try {
      sessionStorage.setItem(`student_video_mode_${code}`, studentVideoMode);
    } catch {
      /* ignore */
    }
  }, [isTeacher, code, studentVideoMode]);
  /**
   * Local roster filter. A timestamp is stored only once the phase is already
   * `gone` (the grace has elapsed), so the filter must not add the grace again.
   * Video tiles read the same map.
   */
  const [droppedStudents, setDroppedStudents] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [reconnectingIds, setReconnectingIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!isTeacher || !room) return;
    type Mark = { phase: PresencePhase; since: number; signal: 'lost' | 'left'; postedLeft: boolean };
    const marks = new Map<string, Mark>();
    const timers = new Map<string, number>();
    // Quality Lost is a bad link, not a leave. It must not report /presence
    // left: under load that dropped people who were still in the room.
    const qualityLost = new Set<string>();
    const publish = () => {
      const dropped = new Map<string, number>();
      const reconnecting = new Set<string>(qualityLost);
      for (const [id, m] of marks) {
        if (m.phase === 'gone') {
          dropped.set(id, m.since);
          reconnecting.delete(id);
        } else if (m.phase === 'reconnecting') reconnecting.add(id);
      }
      setDroppedStudents(dropped);
      setReconnectingIds(reconnecting);
    };
    const report = (kind: 'joined' | 'left', identity: string, sid: string) => {
      void roomFetch(code, '/presence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity, sid, kind }),
      }).catch(() => undefined);
    };
    const clearTimer = (id: string) => {
      const t = timers.get(id);
      if (t != null) window.clearTimeout(t);
      timers.delete(id);
    };
    const apply = (identity: string, signal: 'ok' | 'lost' | 'left', sid: string | undefined) => {
      clearTimer(identity);
      const now = Date.now();
      const cur = marks.get(identity);
      if (signal === 'ok') {
        if (cur?.postedLeft && sid) report('joined', identity, sid);
        if (cur) marks.delete(identity);
        publish();
        return;
      }
      if (cur?.phase === 'gone') return;
      const same = !!cur && cur.signal === signal;
      const since = same ? cur.since : now;
      const phaseIn: PresencePhase = same ? cur.phase : 'present';
      const next = nextPresencePhase(phaseIn, since, signal, now);
      let postedLeft = cur?.postedLeft ?? false;
      if (same && cur.phase === 'reconnecting' && next === 'reconnecting') {
        const grace = signal === 'left' ? STUDENT_GONE_GRACE_MS : LOST_GRACE_MS;
        const wait = Math.max(0, since + grace - now) + 40;
        timers.set(
          identity,
          window.setTimeout(() => apply(identity, signal, sid), wait)
        );
        return;
      }
      if (next === 'gone') {
        if (!postedLeft && sid) {
          report('left', identity, sid);
          postedLeft = true;
        }
        marks.set(identity, { phase: 'gone', since: now, signal, postedLeft });
        publish();
        return;
      }
      if (signal === 'left' && !postedLeft && sid) {
        report('left', identity, sid);
        postedLeft = true;
      }
      marks.set(identity, { phase: 'reconnecting', since, signal, postedLeft });
      const grace = signal === 'left' ? STUDENT_GONE_GRACE_MS : LOST_GRACE_MS;
      const wait = Math.max(0, since + grace - now) + 40;
      timers.set(
        identity,
        window.setTimeout(() => apply(identity, signal, sid), wait)
      );
      publish();
    };
    const onDisconnected = (p: RemoteParticipant) => {
      if (!p.identity?.startsWith('student_')) return;
      qualityLost.delete(p.identity);
      apply(p.identity, 'left', p.sid);
    };
    const onConnected = (p: RemoteParticipant) => {
      if (!p.identity?.startsWith('student_')) return;
      qualityLost.delete(p.identity);
      // Always tell the server, matching the previous join report. Clear
      // postedLeft first so apply('ok') does not send a second joined.
      if (p.sid) report('joined', p.identity, p.sid);
      const cur = marks.get(p.identity);
      if (cur) cur.postedLeft = false;
      apply(p.identity, 'ok', p.sid);
    };
    const onQuality = (quality: ConnectionQuality, p: Participant) => {
      if (p.isLocal || !p.identity?.startsWith('student_')) return;
      // An explicit disconnect owns the grace. A Lost/Excellent that follows
      // pagehide must not stretch it or undo the leave.
      if (marks.get(p.identity)?.signal === 'left') return;
      if (quality === ConnectionQuality.Lost) {
        qualityLost.add(p.identity);
        publish();
        return;
      }
      if (
        quality === ConnectionQuality.Excellent ||
        quality === ConnectionQuality.Good ||
        quality === ConnectionQuality.Poor
      ) {
        const recovered = qualityLost.delete(p.identity);
        const cur = marks.get(p.identity);
        if (cur?.signal === 'lost') apply(p.identity, 'ok', p.sid);
        else if (recovered) publish();
      }
    };
    room.on(RoomEvent.ParticipantDisconnected, onDisconnected);
    room.on(RoomEvent.ParticipantConnected, onConnected);
    room.on(RoomEvent.ConnectionQualityChanged, onQuality);
    return () => {
      room.off(RoomEvent.ParticipantDisconnected, onDisconnected);
      room.off(RoomEvent.ParticipantConnected, onConnected);
      room.off(RoomEvent.ConnectionQualityChanged, onQuality);
      for (const t of timers.values()) window.clearTimeout(t);
    };
  }, [isTeacher, room, code]);
  useEffect(() => {
    if (isTeacher || !room) return;
    let unload = false;
    const send = () => {
      if (unload) return;
      const sid = room.localParticipant?.sid;
      if (!sid) return;
      void roomFetch(code, '/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid }),
      }).catch(() => undefined);
    };
    send();
    const period = heartbeatPeriodMs();
    const startAt = Math.floor(Math.random() * Math.min(period, HEARTBEAT_INTERVAL_MS));
    let iv = 0;
    const start = window.setTimeout(() => {
      send();
      iv = window.setInterval(send, period);
    }, startAt);
    const onVis = () => {
      if (document.visibilityState === 'visible') send();
    };
    const onUnload = () => {
      unload = true;
    };
    const onUp = () => send();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onUnload);
    room.on(RoomEvent.Connected, onUp);
    room.on(RoomEvent.Reconnected, onUp);
    return () => {
      unload = true;
      window.clearTimeout(start);
      window.clearInterval(iv);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onUnload);
      room.off(RoomEvent.Connected, onUp);
      room.off(RoomEvent.Reconnected, onUp);
    };
  }, [isTeacher, room, code]);
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
  const [fsHintOff, setFsHintOff] = useState(false);
  const [endAsk, setEndAsk] = useState(false);
  const [endingClass, setEndingClass] = useState(false);
  // No element fullscreen (iPhone Safari): same look, as a scroll-locked fixed page.
  usePseudoFullscreen(!isTeacher && focus.focusMode);
  const [camError, setCamError] = useState<string | null>(null);
  const [hudOpen, setHudOpen] = useState(false);
  const [hudNotice, setHudNotice] = useState('');
  /** Share tuned for a playing video (30 fps, motion) instead of slides. Remembered in this tab. */
  const [dataSaver, setDataSaver] = useDataSaver();
  // Video mode is manual and starts OFF for every share (slides by default).
  const [videoMode, setVideoModeState] = useState(false);
  const videoModeRef = useRef(videoMode);
  /** Teacher roster search (name / SID). */
  const [rosterQuery, setRosterQuery] = useState('');
  // Large classes: render the roster / waiting list a page at a time (lib/rosterWindow).
  const [rosterLimit, setRosterLimit] = useState(ROSTER_PAGE);
  const [waitingLimit, setWaitingLimit] = useState(ROSTER_PAGE);
  useEffect(() => {
    setRosterLimit(ROSTER_PAGE);
    setWaitingLimit(ROSTER_PAGE);
  }, [rosterQuery]);
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
  // B1: duck the mic while the share's computer sound is loud (speaker bleed).
  useMicDuck(isTeacher, localParticipant, () => screenAudioRef.current?.track ?? null, (t) => setHudNotice(t));
  const [maskActive, setMaskActive] = useState(false);
  const [maskFallback, setMaskFallback] = useState<MaskFallback>('');
  /** One-time Wayland position note. The yellow strip under the pill is not used. */
  const [positionToast, setPositionToast] = useState(false);
  useEffect(() => {
    if (maskFallback !== 'position') {
      setPositionToast(false);
      return;
    }
    let seen: string | null = null;
    try {
      seen = localStorage.getItem(SHARE_POSITION_NOTICE_KEY);
    } catch {
      seen = '1';
    }
    setPositionToast(sharePositionNoticeOpen(seen));
  }, [maskFallback]);
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
    .map((a) => ({ id: a.id, displayName: a.displayName, sid: a.sid ?? null, gradeDivision: a.gradeDivision ?? null }));
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
  // Stable arrays (same contents → same identity) so the children's LiveKit
  // listeners are not torn down and re-added on every render of this view.
  const teacherKey = (state?.admitted ?? [])
    .filter((a) => a.role === 'TEACHER')
    .map((a) => a.livekitIdentity)
    .join(',');
  const studentKey = (state?.admitted ?? [])
    .filter((a) => a.role === 'STUDENT')
    .map((a) => a.livekitIdentity)
    .join(',');
  const teacherIdentities = useMemo(() => (teacherKey ? teacherKey.split(',') : []), [teacherKey]);
  const studentIdentities = useMemo(() => (studentKey ? studentKey.split(',') : []), [studentKey]);
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
  const liveRoster = useMemo(() => {
    if (!state) return null;
    const ids = new Set<string>();
    for (const p of state.admitted ?? []) {
      if (p.role === 'STUDENT' && p.livekitIdentity) ids.add(p.livekitIdentity);
    }
    return ids;
  }, [state]);
  const shownVisibles = useMemo(
    () => selectTeacherVideos(visibles, { dropped: droppedStudents, now: Date.now(), liveRoster }),
    [visibles, droppedStudents, liveRoster]
  );
  const hiddenVideoList = useMemo(() => {
    const opts = { dropped: droppedStudents, now: Date.now(), liveRoster };
    const ids: string[] = [];
    const seen = new Set<string>();
    const consider = (id: string) => {
      if (!id || seen.has(id) || !videoHidden(id, opts)) return;
      seen.add(id);
      ids.push(id);
    };
    for (const id of droppedStudents.keys()) consider(id);
    for (const id of visibles) consider(id);
    if (state?.spotlight?.identity) consider(state.spotlight.identity);
    return ids;
  }, [droppedStudents, liveRoster, visibles, state?.spotlight?.identity]);

  useEffect(() => {
    if (effectiveMuted) setMicOn(false);
  }, [effectiveMuted]);

  // Teacher: the mic usually goes live without a click on it (on at join), so
  // the first tap or key press anywhere starts the noise-removal audio, and a
  // mic published plain until then is republished cleaned up.
  useEffect(() => {
    if (!isTeacher) return;
    const prime = () => primeVoiceAudio(true);
    const opts = { capture: true, passive: true } as const;
    document.addEventListener('pointerdown', prime, opts);
    document.addEventListener('keydown', prime, opts);
    return () => {
      document.removeEventListener('pointerdown', prime, opts);
      document.removeEventListener('keydown', prime, opts);
    };
  }, [isTeacher]);

  // Teacher away → mic off. It stays off when the teacher returns: the student
  // unmutes themselves (never auto-unmute the class).
  useEffect(() => {
    if (micLockedNoTeacher) setMicOn(false);
  }, [micLockedNoTeacher]);

  // Student: taken over by another device, or removed by the teacher.
  useEffect(() => {
    if (isTeacher) return;
    const r = finishFromState(state);
    if (r && r !== 'ended') onFinished(r);
  }, [isTeacher, state, onFinished]);

  // Teacher: toast when a student's newer device takes over their seat.
  const takeoverSeen = useRef(Date.now());
  const [takeoverToast, setTakeoverToast] = useState<string | null>(null);
  useEffect(() => {
    if (!isTeacher) return;
    const fresh = freshTakeovers(state?.takeovers, takeoverSeen.current);
    if (!fresh.length) return;
    takeoverSeen.current = Math.max(...fresh.map((t) => t.at));
    setTakeoverToast(takeoverToastText(fresh[fresh.length - 1]!));
  }, [isTeacher, state?.takeovers]);
  useEffect(() => {
    if (!takeoverToast) return;
    const t = window.setTimeout(() => setTakeoverToast(null), 8000);
    return () => window.clearTimeout(t);
  }, [takeoverToast]);

  // The ENDED reply may carry no class details, so keep the last one seen.
  const classSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (state?.classInfo?.classSessionId) classSessionIdRef.current = state.classInfo.classSessionId;
  }, [state?.classInfo?.classSessionId]);
  useEffect(() => {
    if (state?.status === 'ENDED' || state?.ended) {
      noteClassEnded(code);
      try {
        room?.disconnect();
      } catch {
        /* ignore */
      }
      onClassEnded(state?.classInfo?.classSessionId ?? classSessionIdRef.current);
    }
  }, [state?.status, state?.ended, state?.classInfo?.classSessionId, room, onClassEnded, code]);

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
        // A crashed student must not be pulled back into the visible sample.
        if (videoHidden(s.identity, { dropped: droppedStudents, now: Date.now(), liveRoster })) continue;
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
  }, [isTeacher, room, code, refresh, state?.admitted, state?.visibleIdentities, visibleIdentities, droppedStudents, liveRoster]);

  /** Cameras on demand: tell the server whether the student-video panel is shown. */
  const panelReported = useRef<boolean | null>(null);
  const reportVideoPanel = useCallback(
    (open: boolean) => {
      if (!isTeacher || panelReported.current === open) return;
      panelReported.current = open;
      void roomFetch(code, '/video-panel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ open }),
      }).catch(() => {
        panelReported.current = null;
      });
    },
    [code, isTeacher]
  );

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
          await raw.applyConstraints({
            ...raw.getConstraints(),
            frameRate: profile.capture.frameRate,
            ...(profile.capture.width ? { width: profile.capture.width } : {}),
            ...(profile.capture.height ? { height: profile.capture.height } : {}),
          });
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
      void applyShareProfile(on);
    },
    [applyShareProfile]
  );

  /**
   * Share ↔ whiteboard swap without a republish (load test: unpublishing the
   * share in front of ~2,000 subscribers renegotiated every subscriber at once
   * and set off a reconnect storm). Opening the board MUTES the screen
   * publication and keeps the capture; going back to the share unmutes it. Only
   * a mute flag travels to subscribers, no SDP renegotiation, and the LiveKit
   * connection is never touched. A parked share is released (really
   * unpublished) when the board closes some other way, when the capture ends,
   * or after PARK_MAX_MS.
   */
  const parkedShareRef = useRef<{ timer: number } | null>(null);
  const releaseParkedShare = useCallback(async () => {
    const p = parkedShareRef.current;
    if (!p) return;
    parkedShareRef.current = null;
    window.clearTimeout(p.timer);
    if (!localParticipant) return;
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
  }, [localParticipant, endShareSession]);

  /** true = the share is parked (muted, still published); false = caller must unpublish. */
  const parkShare = useCallback(async (): Promise<boolean> => {
    if (!localParticipant || maskRef.current || parkedShareRef.current) return false;
    const pub = localParticipant.getTrackPublication(Track.Source.ScreenShare);
    if (!pub?.track || !screenCaptureLive(pub)) return false;
    stageSwitchRef.current = true;
    try {
      await pub.mute();
      await screenAudioRef.current?.track.mute().catch(() => undefined);
    } catch {
      return false;
    } finally {
      stageSwitchRef.current = false;
    }
    shareWantedRef.current = false;
    attachShareSurface(null);
    closeAllSideWindows();
    setScreenOn(false);
    setHudOpen(false);
    parkedShareRef.current = { timer: window.setTimeout(() => void releaseParkedShare(), PARK_MAX_MS) };
    const media = pub.track.mediaStreamTrack;
    media?.addEventListener('ended', () => void releaseParkedShare(), { once: true });
    void postStage('idle');
    return true;
  }, [localParticipant, attachShareSurface, releaseParkedShare, postStage]);

  /**
   * Called synchronously from the share click: true = the parked share is
   * coming back (no getDisplayMedia). The controls window opens in the same
   * turn so the user gesture is not spent.
   */
  const resumeParkedShare = useCallback((): boolean => {
    const p = parkedShareRef.current;
    if (!p || !localParticipant) return false;
    const pub = localParticipant.getTrackPublication(Track.Source.ScreenShare);
    if (!pub?.track || !screenCaptureLive(pub)) {
      void releaseParkedShare();
      return false;
    }
    parkedShareRef.current = null;
    window.clearTimeout(p.timer);
    const controlsPromise = beginShareControls();
    void (async () => {
      try {
        await pub.unmute();
        await screenAudioRef.current?.track.unmute().catch(() => undefined);
      } catch (e) {
        console.warn('resume share', e);
      }
      shareWantedRef.current = true;
      setScreenOn(true);
      setChatOpen(false);
      setRosterOpen(false);
      const controls = await controlsPromise.catch(() => null);
      attachShareSurface(controls);
      await postStage('screen');
    })();
    return true;
  }, [localParticipant, releaseParkedShare, attachShareSurface, postStage]);

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
    if (resumeParkedShare()) return;

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
    const firstAudio = stream.getAudioTracks().find((t) => t.readyState === 'live') ?? null;
    // Echo guard (lib/audioPolicy): whole-screen system audio would include
    // this tab's playback of students' voices unless the browser excludes it.
    const audioSurface = String((media?.getSettings?.() as { displaySurface?: string } | undefined)?.displaySurface ?? '');
    const shareAudio =
      firstAudio && keepShareAudio(audioSurface, firstAudio.getSettings?.() as { restrictOwnAudio?: boolean }) ? firstAudio : null;
    if (firstAudio && !shareAudio) {
      setHudNotice('Computer sound was not sent: this browser cannot keep students\' voices out of a whole-screen share. Share a browser tab to send its sound.');
    }
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
      const simulcast = screenShare().simulcast && screenShareSimulcastFor(capW, capH);
      // Slides: text must stay sharp, so under CPU/bandwidth pressure drop
      // frames, not pixels. Video mode: the reverse (smooth 30 fps).
      const profile = shareProfile(videoModeRef.current);
      try {
        published.mediaStreamTrack.contentHint = profile.contentHint;
      } catch {
        /* ignore */
      }
      // VP9 L2T3_KEY + VP8 backup (Chromium); VP8 simulcast elsewhere. See SHARE_CODEC.
      const vp9 = shareUsesVp9(navigator.userAgent || '');
      const shareOpts = (layered: boolean, useVp9 = vp9) => ({
        name: 'screen',
        source: Track.Source.ScreenShare,
        ...(useVp9
          ? {
              videoCodec: SHARE_CODEC.codec,
              scalabilityMode: SHARE_CODEC.scalabilityMode,
              backupCodec: { codec: SHARE_CODEC.backupCodec },
            }
          : {}),
        simulcast: layered || useVp9,
        screenShareEncoding: profile.top,
        degradationPreference: profile.degradationPreference as RTCDegradationPreference,
        screenShareSimulcastLayers: layered
          ? screenShare().layers.map(
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
          if ((!simulcast && !vp9) || media.readyState !== 'live') throw err;
          console.warn('screen share simulcast failed; publishing a single layer', err);
          await localParticipant.unpublishTrack(published, false).catch(() => undefined);
          // Plain single-layer VP8: the most compatible publish.
          await localParticipant.publishTrack(published, shareOpts(false, false));
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
  }, [localParticipant, screenOn, isTeacher, postStage, endShareSession, attachShareSurface, room, resumeParkedShare]);

  async function leave() {
    // Student: show "You left" first (the server's removal from LiveKit would
    // otherwise arrive first and read as "removed by the teacher").
    if (!isTeacher) onFinished('left');
    await roomFetch(code, '/leave', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!isTeacher) return; // static "you left" screen already shown
    room?.disconnect();
    router.push('/teacher/dashboard');
  }

  function endClass() {
    setEndAsk(true);
  }

  async function confirmEndClass() {
    if (endingClass) return;
    setEndingClass(true);
    try {
      const res = await roomFetch(code, '/end', { method: 'POST' });
      if (!res.ok) {
        setHudNotice('Could not end the class. Everyone is still in the room.');
        setEndingClass(false);
        setEndAsk(false);
        return;
      }
      setEndAsk(false);
      room?.disconnect();
      // Teacher: stay on the "Class finished" screen (it has a Dashboard button)
      // instead of jumping straight back to the dashboard.
      onClassEnded(classSessionIdRef.current);
    } catch {
      setHudNotice('Could not end the class. Everyone is still in the room.');
      setEndingClass(false);
      setEndAsk(false);
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
    setMuteOverrides((cur) => ({ ...cur, [participantId]: muted }));
    const ok = await roomFetch(code, '/mute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ participantId, muted }),
    })
      .then((r) => r.ok)
      .catch(() => false);
    if (!ok) {
      setMuteOverrides((cur) => {
        const next = { ...cur };
        delete next[participantId];
        return next;
      });
    }
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

  // Whiteboard (teacher): exclusive with the screen share.
  const [wbOpen, setWbOpen] = useState(false);
  /** Student videos stay up when the board opens. The meeting bar can hide them. */
  const [wbVideosOn, setWbVideosOn] = useState(true);
  const [wbAllMuted, setWbAllMuted] = useState(false);
  /** In-tab class panel while sharing without a separate videos window. */
  const [shareVideosOn, setShareVideosOn] = useState(true);
  // Fresh teacher session: reopen a board this tab still has, or clear a stale flag.
  const wbChecked = useRef(false);
  useEffect(() => {
    if (!isTeacher || !state || wbChecked.current) return;
    wbChecked.current = true;
    if (!state.whiteboard) return;
    if (hasSavedBoard(code)) setWbOpen(true);
    else void roomFetch(code, '/whiteboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'off' }) });
  }, [isTeacher, state, code]);
  const wbStopRef = useRef<(() => void) | null>(null);
  const closeWhiteboard = useCallback((opts?: { keepParkedShare?: boolean }) => {
    setWbOpen(false);
    // Board closed without going back to the share: really stop the parked share.
    if (!opts?.keepParkedShare) void releaseParkedShare();
    void roomFetch(code, '/whiteboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'off' }) });
  }, [code, releaseParkedShare]);

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

  const [muteOverrides, setMuteOverrides] = useState<Record<string, boolean>>({});
  useEffect(() => {
    // Drop an override once the server agrees (or the student left).
    setMuteOverrides((cur) => {
      const ids = Object.keys(cur);
      if (!ids.length) return cur;
      const next = { ...cur };
      for (const id of ids) {
        const p = state?.admitted?.find((x) => x.id === id);
        if (!p || !!p.mutedByTeacher === cur[id]) delete next[id];
      }
      return Object.keys(next).length === ids.length ? cur : next;
    });
  }, [state?.admitted]);
  const waitingCount = state?.waiting?.length ?? 0;
  // Roster panel: students only (the teacher is not listed), raised hands
  // first by raise time, then pinned, then by name. Two devices of one
  // student count once, same rule as admin "Students connected".
  const rosterStudents = distinctConnectedStudents(
    sortRoster(
      (state?.admitted ?? [])
        .filter((p) => p.role === 'STUDENT' && !isRosterDropped(p.livekitIdentity, droppedStudents, Date.now()))
        .map((p) => ({
          ...p,
          handRaised: !!(p.handRaised || (state?.raisedHands ?? []).includes(p.id)),
          // Item 14: per-student mute flips at once; the server state confirms it.
          mutedByTeacher: p.id in muteOverrides ? muteOverrides[p.id] : p.mutedByTeacher,
        }))
    ).map((p) => ({
      ...p,
      identity: p.livekitIdentity,
      studentId: p.studentId ?? null,
    }))
  );
  const studentCount = rosterStudents.length;
  const rosterWin = rosterWindow(filterPeople(rosterStudents, rosterQuery), rosterLimit);
  const waitingWin = rosterWindow(filterPeople(state?.waiting ?? [], rosterQuery), waitingLimit);
  const shownRoster = rosterWin.shown;
  const shownWaiting = waitingWin.shown;
  /** Raised hands, earliest first: shown in the chat panel so they stay in
   * sight while the roster is closed. */
  const raisedHands = rosterStudents
    .filter((p) => p.handRaised)
    .map((p) => ({ id: p.id, displayName: p.displayName }));
  // Teacher: raised hands and unread chat in the tab title, so they show in
  // the tab strip / taskbar while the teacher looks at the shared display.
  const handsN = isTeacher ? raisedHands.length : 0;
  const unreadN = isTeacher ? chatUnread : 0;
  useTabTitle(teacherTabTitle(pageTitle(state?.name || 'Class'), handsN, unreadN));
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

  /** One spotlighted student at a time. Null clears it. */
  async function setSpotlight(participantId: string | null) {
    try {
      const res = await roomFetch(code, '/spotlight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ participantId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setHudNotice((data as { error?: string }).error || 'Could not change spotlight');
      }
    } catch {
      setHudNotice('Could not change spotlight');
    }
    refresh();
  }

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
  /** Raised hand → give the student the floor: unmute them, then lower the hand. */
  async function letSpeak(participantId: string) {
    await muteStudent(participantId, false);
    await lowerHand(participantId);
  }
  const mutedStudentIds = useMemo(
    () => new Set((state?.admitted ?? []).filter((p) => p.role === 'STUDENT' && p.mutedByTeacher).map((p) => p.id)),
    [state?.admitted]
  );
  // —— Student drawing on the shared screen (ShareDrawing.tsx, lib/drawLogic.ts) ——
  const drawActions = useDrawingActions(code);
  const drawHolders = state?.drawHolders ?? (state?.drawHolder ? [state.drawHolder] : []);
  const drawHolderNames = drawHolders.map((h) => h.name);
  // Teacher views label every drawer; a student keeps their own allow (timer).
  const drawHolder =
    isTeacher && drawHolders.length > 1 && drawHolders[0]
      ? { ...drawHolders[0], name: drawHolderNames.join(', ') }
      : (state?.drawHolder ?? null);
  const sharingNow = isTeacher
    ? screenOn || stageMode === 'screen' || wbOpen
    : effectiveStage === 'screen' || !!state?.whiteboard;
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
  // Tell a student when their drawing stops without them asking (teacher
  // revoked it, the time ran out, or the share stopped).
  const prevServerDraw = useRef(serverDrawState);
  useEffect(() => {
    const prev = prevServerDraw.current;
    prevServerDraw.current = serverDrawState;
    if (isTeacher || prev !== 'drawing' || serverDrawState === 'drawing') return;
    if (drawOverride === 'off') return; // I pressed Stop drawing myself.
    setHudNotice('Your teacher stopped your drawing.');
  }, [isTeacher, serverDrawState, drawOverride]);
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
      return;
    }
    if (drawToast && !ids.has(drawToast.id)) setDrawToast(null);
    setHudNotice((n) => {
      if (!n || !n.includes(' asks to draw on your screen.')) return n;
      const stillAsking = drawRequesters.find((p) => n.startsWith(p.displayName));
      if (stillAsking) return n;
      const next = drawRequesters[0];
      return next ? `${next.displayName} asks to draw on your screen. Allow in the roster.` : '';
    });
  }, [isTeacher, drawRequesters, drawToast]);
  useEffect(() => {
    if (!drawToast) return;
    const t = window.setTimeout(() => setDrawToast(null), 12_000);
    return () => window.clearTimeout(t);
  }, [drawToast]);

  const micLimitOn = (state?.micLimit ?? 0) > 0;
  const micWaiting = !!state?.me?.micWaiting;
  const showAskToSpeak = !isTeacher && micLimitOn && effectiveMuted && !state?.me?.micGranted;
  // No mic cap: asking to speak raises the hand, and the teacher's raised-hands
  // bar has "Let … speak" (unmutes and lowers it).
  const askByHand = !isTeacher && !micLimitOn && effectiveMuted;
  const controlsProps = {
    micOn: micOn && !effectiveMuted,
    camOn,
    screenOn,
    onToggleMic: () => {
      if ((effectiveMuted || micLockedNoTeacher) && !isTeacher) return;
      const turningOff = micOn;
      // In the click itself: Safari starts audio processing only from a tap.
      if (!turningOff) primeVoiceAudio(isTeacher);
      setMicOn((v) => !v);
      if (!isTeacher && micLimitOn && !effectiveMuted && turningOff) {
        void roomFetch(code, '/mic', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ want: false }),
        }).then(() => refresh());
      }
    },
    onToggleCam: () => setCamOn((v) => !v),
    onToggleScreen: () => {
      // Screen share and whiteboard are exclusive: starting a share closes the board.
      if (!screenOn && wbOpen) closeWhiteboard({ keepParkedShare: true });
      void toggleScreen();
    },
    whiteboardOn: wbOpen,
    onToggleWhiteboard: isTeacher
      ? () => {
          if (wbOpen) return closeWhiteboard();
          void roomFetch(code, '/whiteboard', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'on' }),
          });
          if (!screenOn) {
            setWbOpen(true);
            return;
          }
          const unpublishThenOpen = () => {
            let opened = false;
            const onUnpub = (pub: LocalTrackPublication) => {
              if (pub?.source !== Track.Source.ScreenShare) return;
              if (opened) return;
              opened = true;
              room.off(RoomEvent.LocalTrackUnpublished, onUnpub);
              setWbOpen(true);
            };
            room.on(RoomEvent.LocalTrackUnpublished, onUnpub);
            void toggleScreen().finally(() => {
              if (opened) return;
              opened = true;
              room.off(RoomEvent.LocalTrackUnpublished, onUnpub);
              setWbOpen(true);
            });
          };
          // Preferred: park the share (mute only, no republish / renegotiation).
          void parkShare().then((parked) => {
            if (parked) setWbOpen(true);
            else unpublishThenOpen();
          });
        }
      : undefined,
    videoPanelLabel: isTeacher ? undefined : studentVideoModeLabel(studentVideoMode),
    videoPanelShortLabel: isTeacher ? undefined : studentVideoModeShortLabel(studentVideoMode),
    onCycleVideoPanel: isTeacher ? undefined : () => setStudentVideoMode((m) => nextStudentVideoMode(m)),
    askToSpeakLabel: micWaiting
      ? state?.me?.micPosition
        ? `Waiting (#${state.me.micPosition})`
        : 'Waiting'
      : 'Ask to speak',
    onAskToSpeak: showAskToSpeak
      ? () => {
          void roomFetch(code, '/mic', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ want: !micWaiting }),
          }).then(() => refresh());
        }
      : askByHand && !handRaised
        ? () => void toggleHand()
        : undefined,
    micWaitNote:
      !isTeacher && micWaiting
        ? `Waiting to speak${state?.me?.micPosition ? ` (#${state.me.micPosition})` : ''}`
        : askByHand && handRaised
          ? 'Hand raised. Your teacher can let you speak.'
          : null,
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
    dataSaver: isTeacher ? undefined : dataSaver,
    onCycleDataSaver: isTeacher ? undefined : () => setDataSaver(nextDataSaver(dataSaver)),
  };
  const withDrawing = (node: ReactNode) => (
    <ShareDrawingProvider
      code={code}
      active={isTeacher ? screenOn || stageMode === 'screen' : effectiveStage === 'screen' && !state?.whiteboard}
      holder={drawHolder}
      myIdentity={state?.me?.livekitIdentity ?? localParticipant.identity}
      canDraw={!isTeacher && myDrawState === 'drawing' && !!state?.me?.canDraw}
      desktopInk={!!state?.desktopInk}
    >
      <TeacherInkProvider
        active={isTeacher ? screenOn : effectiveStage === 'screen' && !state?.whiteboard}
        publish={isTeacher}
      >
        {node}
      </TeacherInkProvider>
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
    // Nothing shared: the teacher's camera fills the stage (unless the student
    // minimised videos to save data or space).
    const teacherOnStage = teacherHere && !showTeacherScreen && !state?.whiteboard && studentVideoMode !== 'min';
    const fsGate = fullscreenGate({
      status: focus.status,
      everFullscreen: focus.everFullscreen,
      iphone: focus.iphone,
    });
    const covered = fsGate === 'block';
    const fsText = fullscreenGateText({ status: focus.status, everFullscreen: focus.everFullscreen });
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
          canPublishVideo={effectiveCanPublish || !!state?.me?.spotlighted}
          camWanted={effectiveCamWanted(state?.me) || (!state?.me && effectiveCanPublish)}
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
          spotlightIdentity={state?.spotlight?.identity ?? null}
        />
        <RoomAudioRenderer />

        {/* Status and class details share one row, so the phone's "Muted by
            teacher" pill (below it) never covers the info button. Class
            details hide under the fullscreen cover, same as the video float. */}
        <div className="stage-top-left">
          <div className="stage-fullscreen-badge">{badge}</div>
          {!covered && (
            <ClassInfoButton
              teacherName={state?.classInfo?.teacherName || state?.teacherName || null}
              subject={state?.classInfo ? state.classInfo.subject : state?.name || null}
              audience={state?.classInfo?.audience || null}
              scheduledStart={state?.classInfo?.scheduledStart ?? null}
              scheduledEnd={state?.classInfo?.scheduledEnd ?? null}
            />
          )}
        </div>

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
            aria-label={fsText.label}
          >
            <IconScreen size={36} className="text-brand-300" />
            <span className="font-display text-xl font-semibold">{fsText.title}</span>
            <span className="max-w-sm text-sm text-slate-400">{fsText.body}</span>
          </button>
        )}
        {fsGate === 'hint' && !fsHintOff && (
          <div
            className="fixed left-3 right-3 top-14 z-[70] flex flex-wrap items-center justify-center gap-2 rounded-xl border border-white/15 bg-black/75 px-3 py-2 text-center text-xs text-white"
            role="status"
            data-testid="fullscreen-hint"
          >
            <span className="max-w-sm">{fsText.body}</span>
            <button
              type="button"
              className="rounded-lg bg-white/15 px-3 py-2 font-semibold"
              onClick={() => void focus.returnToFullscreen()}
            >
              {fsText.label}
            </button>
            <button type="button" className="px-2 py-2 text-slate-300" onClick={() => setFsHintOff(true)} aria-label="Dismiss fullscreen hint">
              Dismiss
            </button>
          </div>
        )}

        {/* Small portrait screens (any device): a hint only, never blocks taps or audio. */}
        {focus.portrait && viewport.w < 640 && showTeacherScreen && (
          <div className="pointer-events-none fixed inset-x-3 top-[6.5rem] z-[30] rounded-xl border border-white/15 bg-black/70 px-3 py-2 text-center text-xs font-semibold text-white backdrop-blur">
            Rotate your phone to landscape for a bigger view
          </div>
        )}

        <div className="absolute inset-0 z-10">
          {/* The whiteboard stays mounted under the fullscreen cover (data only, no
              video), so it is there at once when the student re-enters. */}
          {state?.whiteboard && !teacherGone ? (
            <WhiteboardViewer
              identity={state?.me?.livekitIdentity ?? localParticipant.identity}
              canAnnotate={myDrawState === 'drawing' && !!state?.me?.canDraw}
              requestSnapshot={() =>
                void roomFetch(code, '/whiteboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'req' }) })
              }
              sendOps={(ops) =>
                roomFetch(code, '/whiteboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'ops', ops }) })
              }
              fetchStored={async () => {
                const res = await roomFetch(code, '/whiteboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stored' }) });
                const j = res.ok ? ((await res.json().catch(() => null)) as { packets?: unknown } | null) : null;
                return j?.packets ?? [];
              }}
            />
          ) : covered ? null : showTeacherScreen ? (
            <TeacherScreenStage teacherIdentities={teacherIdentities} zoomable drawing={myDrawState === 'drawing'} />
          ) : teacherOnStage ? (
            <TeacherStageCamera
              teacherIdentities={teacherIdentities}
              fallback="Their screen will fill this view when they share it."
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

        {/* Teacher video hidden: receive no teacher camera at all. */}
        {covered && <TeacherMediaDemand teacherIdentities={teacherIdentities} mode={dataSaver} camPaneMinimized />}
        {/* The one student video float (teacher, screen share and whiteboard). */}
        {!covered && (
          <TeacherCameraFloat
            teacherIdentities={teacherIdentities}
            roomCode={code}
            selfName={displayName}
            selfStream={localCamStream}
            camOn={camOn}
            mode={studentVideoMode}
            teacherOnStage={teacherOnStage}
          />
        )}
        {!covered && state?.spotlight && state.spotlight.identity !== state.me?.livekitIdentity && (
          <SpotlightFloat identity={state.spotlight.identity} name={state.spotlight.name} />
        )}

        {/* Student controls: a vertical panel on the right edge, on every device. */}
        <div
          className="stage-float-chrome is-rail"
          data-float-bound={viewport.w <= 700 && viewport.h > viewport.w ? 'bottom' : 'right'}
        >
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

  const shareHudEl = (over: Partial<TeacherShareHudProps>) => (
          <TeacherShareHud
            videoMode={videoMode}
            onVideoModeChange={setVideoMode}
            focusAlertCount={focusAlertCount}
            host={shareMount}
            hostWindow={shareWindow}
            inline={!shareMount}
            compact={hudCompact}
            onCompactChange={setHudCompact}
            admitted={(state?.admitted ?? []).filter((p) => {
              if (p.role !== 'STUDENT') return true;
              return !isRosterDropped(p.livekitIdentity, droppedStudents, Date.now());
            }).map((p) => ({
              ...p,
              reconnecting: !!p.reconnecting || reconnectingIds.has(p.livekitIdentity),
            }))}
            waiting={(state?.waiting ?? []).map((w) => ({
              id: w.id,
              displayName: rosterLabel(w),
              role: 'STUDENT',
              sid: w.sid ?? null,
            }))}
            waitingCount={waitingCount}
            onAdmit={(id) => void admitStudents([id])}
            onAdmitAll={() => void admitStudents(undefined, true)}
            waitingRoomOn={waitingRoomOn}
            onWaitingRoom={(on) => void setWaitingRoom(on)}
            teacherMicOn={micOn && !effectiveMuted}
            onToggleTeacherMic={() => {
              if (!micOn) primeVoiceAudio(true);
              setMicOn((v) => !v);
            }}
            teacherCamOn={camOn}
            onToggleTeacherCam={() => setCamOn((v) => !v)}
            sideWindowsAllowed={sideWindowsAllowed}
            sideWindowsNeedTrust={maskActive}
            videosOpen={sideWindowsAllowed ? !!videosWin : shareVideosOn}
            onToggleVideos={() => {
              if (sideWindowsAllowed) toggleVideosWindow();
              else setShareVideosOn((v) => !v);
            }}
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
            toolbarTitle={maskFallback === 'position' ? MONITOR_POSITION_HINT : undefined}
            {...over}
          />
  );

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
      {state?.spotlight && (
        <SpotlightFloat
          identity={state.spotlight.identity}
          name={state.spotlight.name}
          hidden={videoHidden(state.spotlight.identity, {
            dropped: droppedStudents,
            now: Date.now(),
            liveRoster,
          })}
        />
      )}
      {wbOpen && (
        <WhiteboardHost
          code={code}
          identity={localParticipant.identity}
          onClose={() => setWbOpen(false)}
          stopRef={wbStopRef}
        />
      )}

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
        {isTeacher && raisedHands.length > 0 && (
          <RaisedHandsBar
            hands={raisedHands}
            mutedIds={mutedStudentIds}
            onLetSpeak={(id) => void letSpeak(id)}
            onLower={(id) => void lowerHand(id)}
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
                    const v = videosShown(shownVisibles.length, slots);
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

      {isTeacher && takeoverToast && (
        <div className="teacher-toast" role="status" data-testid="takeover-toast">
          <span className="flex-1">{takeoverToast}</span>
          <button type="button" className="text-xs text-slate-400 hover:text-white" onClick={() => setTakeoverToast(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
      {isTeacher && drawToast && (
        <div className="teacher-toast z-[120]" role="status">
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
      {isTeacher && positionToast && (
        <div className="teacher-toast teacher-toast-left" role="status" data-testid="share-position-toast">
          <span className="flex-1">{MONITOR_POSITION_HINT}</span>
          <button
            type="button"
            className="text-xs text-slate-400 hover:text-white"
            aria-label="Dismiss"
            onClick={() => {
              try {
                localStorage.setItem(SHARE_POSITION_NOTICE_KEY, '1');
              } catch {
                /* private mode */
              }
              setPositionToast(false);
            }}
          >
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
                visibleIdentities={shownVisibles}
                hiddenIdentities={hiddenVideoList}
                isTeacher={isTeacher}
                teacherIdentities={teacherIdentities}
                localShareSurface={shareSurface}
                onStopShare={() => void toggleScreen()}
                onShareScreen={isTeacher && canShareScreen() ? controlsProps.onToggleScreen : undefined}
                onPrepareShare={() => {
                  if (!screenOn && canShareScreen()) preopenShareControls();
                }}
                onOpenWhiteboard={isTeacher ? controlsProps.onToggleWhiteboard : undefined}
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
                      <span className="roster-name" title={p.displayName}>{p.displayName}</span>
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
                  {waitingWin.hidden > 0 && (
                    <li>
                      <button type="button" className="roster-more" onClick={() => setWaitingLimit((n) => n + ROSTER_PAGE)}>
                        Show {waitingWin.next} more ({waitingWin.hidden} not shown; search finds anyone)
                      </button>
                    </li>
                  )}
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
            {(state?.micLimit ?? 0) > 0 && (state?.micQueue?.length ?? 0) > 0 && (
              <div className="shrink-0 rounded-xl border border-white/10 bg-white/[0.03] p-1.5" data-no-drag>
                <h3 className="px-1 text-2xs font-semibold uppercase tracking-wider text-slate-400">Speaking queue</h3>
                <ul className="mt-1 space-y-0.5">
                  {state?.micQueue?.map((q) => (
                    <li key={q.id} className="flex items-center justify-between gap-2 px-1 py-0.5 text-xs text-slate-100">
                      <span className="min-w-0 truncate">{q.name}</span>
                      <span className="shrink-0 text-[10px] text-amber-200">waiting to speak</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {state?.spotlight && (
              <p className="shrink-0 px-1 text-2xs text-amber-200" data-no-drag>
                Spotlight: {state.spotlight.name}
              </p>
            )}
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
                    <span className="roster-name" title={p.displayName}>{p.displayName}</span>
                    {p.gradeDivision && <span className="roster-meta">{p.gradeDivision}</span>}
                    {focus && (
                      <span
                        className={cn('roster-chip', isFocusAlert(p.focus) ? 'roster-chip-warn' : '')}
                        title={focus}
                      >
                        {focus}
                      </span>
                    )}
                    {(reconnectingIds.has(p.livekitIdentity) || p.reconnecting) && (
                      <span className="roster-chip roster-chip-warn" title="Reconnecting">
                        Reconnecting
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
                      <RosterIconButton
                        label={state?.spotlight?.participantId === p.id ? `Stop spotlight on ${p.displayName}` : `Spotlight ${p.displayName} (shown large to the class)`}
                        tone={state?.spotlight?.participantId === p.id ? 'on' : 'plain'}
                        pressed={state?.spotlight?.participantId === p.id}
                        onClick={() => void setSpotlight(state?.spotlight?.participantId === p.id ? null : p.id)}
                      >
                        <IconStar size={13} />
                      </RosterIconButton>
                    </span>
                  </li>
                );
              })}
              {rosterWin.hidden > 0 && (
                <li>
                  <button type="button" className="roster-more" data-testid="roster-more" onClick={() => setRosterLimit((n) => n + ROSTER_PAGE)}>
                    Show {rosterWin.next} more ({rosterWin.hidden} not shown; search finds anyone)
                  </button>
                </li>
              )}
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

      {/* Whiteboard mode: the student video float stays above the board (z 96 > 95). */}
      <div style={wbOpen ? { position: 'relative', zIndex: 96 } : undefined}>
      <TeacherPeersFloat
        roomCode={code}
        teacherIdentities={teacherIdentities}
        visibleIdentities={shownVisibles}
        droppedStudents={droppedStudents}
        liveRoster={liveRoster}
        spotlightIdentity={
          state?.spotlight &&
          !videoHidden(state.spotlight.identity, { dropped: droppedStudents, now: Date.now(), liveRoster })
            ? state.spotlight.identity
            : null
        }
        selfName={displayName}
        selfStream={localCamStream}
        slots={panelSlots}
        onSlotsChange={(studentSlots) => {
          setPanelSlots(panelSlotsForCap(studentSlots));
          void setStudentCameraCap(studentSlots);
        }}
        // Whiteboard: floating, draggable panel like share mode — the board
        // keeps full width instead of docking videos in a right-hand column.
        dock={wbOpen ? null : dockArea}
        minLeft={wbOpen ? WB_TOOL_CLEAR_PX : 0}
        videosHidden={(wbOpen && !wbVideosOn) || (screenOn && !wbOpen && !sideWindowsAllowed && !shareVideosOn)}
        whiteboard={wbOpen}
        sharing={shareLayout}
        onDockSpace={onDockSpace}
        focusAlerts={focusByIdentity}
        pinnedIdentities={pinnedIdentities}
        portalWindow={videosWin}
        onShownChange={reportVideoPanel}
        onTogglePin={(identity, on) => {
          const id = participantIdByIdentity.get(identity);
          if (id) void togglePin(id, on);
        }}
      />
      </div>

      {/* Share controls: in the floating window for window/tab captures; in
          this tab (draggable dock) for entire-screen captures or when no
          window could be opened. Never both. Hidden while the whiteboard
          meeting bar is up. */}
      {isTeacher && screenOn && !wbOpen && (
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
              ? inlineShareDockHint(maskFallback, {
                  share: MONITOR_SHARE_HINT,
                  screens: MONITOR_SCREENS_HINT,
                  unsafe: MONITOR_UNSAFE_HINT,
                })
              : undefined
          }
          title={maskFallback === 'position' ? MONITOR_POSITION_HINT : undefined}
          action={
            maskFallback === 'screens' ? (
              <button type="button" className="share-inline-btn" onClick={() => void requestScreenDetails()}>
                Allow
              </button>
            ) : undefined
          }
          avoidLeft={0}
        >
          {shareHudEl({})}
        </ShareHudSlot>
      )}

      {isTeacher && wbOpen && (
        <WhiteboardMeetingBar
          micOn={micOn && !effectiveMuted}
          onToggleMic={() => {
            if (!micOn) primeVoiceAudio(isTeacher);
            setMicOn((v) => !v);
          }}
          camOn={camOn}
          onToggleCam={() => setCamOn((v) => !v)}
          chatUnread={chatUnread}
          chatOpen={chatOpen}
          onToggleChat={() => setChatOpen((v) => !v)}
          hands={raisedHands.length}
          focusAlerts={focusAlertCount}
          rosterOpen={rosterOpen}
          onToggleRoster={() => setRosterOpen((v) => !v)}
          waiting={(state?.waiting ?? []).map((w) => ({ id: w.id, displayName: rosterLabel(w) }))}
          onAdmit={(id) => void admitStudents([id])}
          onAdmitAll={() => void admitStudents(undefined, true)}
          requests={(state?.admitted ?? [])
            .filter((p) => p.role === 'STUDENT' && p.drawRequested && !p.drawing && !isRosterDropped(p.livekitIdentity, droppedStudents, Date.now()))
            .map((p) => ({ id: p.id, displayName: rosterLabel(p) }))}
          drawers={(state?.admitted ?? [])
            .filter((p) => p.role === 'STUDENT' && p.drawing && !isRosterDropped(p.livekitIdentity, droppedStudents, Date.now()))
            .map((p) => ({ id: p.id, displayName: rosterLabel(p) }))}
          onAllowDraw={(id) => void allowDrawing(id)}
          onRevokeDraw={(id) => void revokeDrawing(id)}
          allMuted={wbAllMuted}
          onToggleMuteAll={() => {
            setWbAllMuted((v) => {
              void muteAllStudents(!v);
              return !v;
            });
          }}
          videosOn={wbVideosOn}
          onToggleVideos={() => setWbVideosOn((v) => !v)}
          onStopWhiteboard={() => {
            if (wbStopRef.current) wbStopRef.current();
            else closeWhiteboard();
          }}
          onEndClass={() => void endClass()}
        />
      )}

      {/* Bottom dock — hidden while the whiteboard meeting bar owns these actions. */}
      {!wbOpen && (
      <footer data-float-bound="bottom" data-testid="teacher-dock" className="relative z-[80] shrink-0 border-t border-white/[0.06] bg-surface-1/90 px-3 py-2.5 backdrop-blur-xl sm:px-4">
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
      )}
      {endAsk && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 px-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="end-class-title"
            data-testid="end-class-confirm"
            className="w-full max-w-sm rounded-2xl border border-white/10 bg-surface-1 p-6 text-center shadow-lift"
          >
            <p id="end-class-title" className="font-display text-lg font-semibold">
              End class for everyone?
            </p>
            <div className="mt-5 flex justify-center gap-3">
              <Button variant="danger" onClick={() => void confirmEndClass()} disabled={endingClass}>
                End class
              </Button>
              <Button variant="secondary" onClick={() => { setEndAsk(false); setEndingClass(false); }} disabled={endingClass}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
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

/** Raised hands in the header: give the first student the floor, or lower the hand. */
function RaisedHandsBar({
  hands,
  mutedIds,
  onLetSpeak,
  onLower,
  onOpenRoster,
}: {
  hands: Array<{ id: string; displayName: string }>;
  mutedIds: Set<string>;
  onLetSpeak: (id: string) => void;
  onLower: (id: string) => void;
  onOpenRoster?: () => void;
}) {
  const first = hands[0];
  if (!first) return null;
  const n = hands.length;
  return (
    <div className="raised-hands-toast order-first" role="status" aria-live="polite" data-testid="raised-hands-toast" aria-label="Raised hands">
      <IconHand size={14} className="shrink-0 text-violet-200" />
      <span className="min-w-0 flex-1 truncate font-semibold">
        {n === 1 ? `${first.displayName} raised a hand` : `${n} hands raised · ${shortName(first.displayName)} first`}
      </span>
      {mutedIds.has(first.id) && (
        <Button variant="secondary" size="sm" onClick={() => onLetSpeak(first.id)} title={`Unmute ${first.displayName} and lower the hand`}>
          Let {shortName(first.displayName)} speak
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={() => onLower(first.id)} aria-label={`Lower hand for ${first.displayName}`}>
        Lower
      </Button>
      {n > 1 && onOpenRoster && (
        <Button variant="ghost" size="sm" onClick={onOpenRoster}>
          All hands
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
  title,
  action,
  avoidLeft = 0,
  children,
}: {
  floating: boolean;
  compact?: boolean;
  popOut?: () => void;
  hint?: string;
  title?: string;
  action?: ReactNode;
  /** While the whiteboard is up, keep the dock clear of the left tool column. */
  avoidLeft?: number;
  children: ReactNode;
}) {
  if (floating) return <>{children}</>;
  return (
    <InlineShareDock onPopOut={popOut} hint={hint} title={title} compact={compact} action={action} avoidLeft={avoidLeft}>
      {children}
    </InlineShareDock>
  );
}

const endProbeCache = new Map<string, ProbeHit<{ httpStatus: number; body: ProbeBody }>>();
const endProbeInflight = new Map<string, Promise<{ httpStatus: number; body: ProbeBody }>>();

export function ClassroomRoom({ code }: { code: string }) {
  const router = useRouter();
  const [tokenData, setTokenData] = useState<TokenPayload | null>(null);
  const [error, setError] = useState('');
  const [classEnded, setClassEnded] = useState(false);
  /** Student: why the class view stopped for good (static screen, zero requests). */
  const [finished, setFinished] = useState<FinishReason | null>(null);
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

  /** Remount key: a rejoin builds a brand-new Room (fresh peer connections). */
  const [connKey, setConnKey] = useState(0);
  const [rejoining, setRejoining] = useState(false);
  const rejoinRef = useRef<{ running: boolean; unmounted: boolean }>({ running: false, unmounted: false });
  /** When this tab last (re)built its Room; see isOwnStaleDuplicate. */
  const connectedAtRef = useRef<number | null>(null);
  /** This LiveKitRoom mount reached Connected at least once (a failed first connect is retried). */
  const everConnectedRef = useRef(false);
  /** Consecutive failed first connects (reset on Connected): drives connectRetryDelayMs. */
  const connectFailuresRef = useRef(0);
  useEffect(() => {
    const r = rejoinRef.current;
    r.unmounted = false;
    return () => {
      r.unmounted = true;
    };
  }, []);

  /**
   * Run-4 fix: rejoin after the SFU connection is lost for longer than
   * LiveKit's own reconnect window (e.g. a 30 s network drop). Waits for the
   * network, fetches a fresh token and mounts a new Room, retrying with
   * backoff until it works or the class is over.
   */
  const rejoin = useCallback(async (opts?: { connectFailures?: number }) => {
    const r = rejoinRef.current;
    if (r.running) return;
    r.running = true;
    setRejoining(true);
    const failures = opts?.connectFailures ?? 0;
    try {
      for (let attempt = 0; !r.unmounted; attempt++) {
        // A failed connect backs off by how many connects failed in a row (the
        // SFU is likely overloaded); other rejoins use the normal schedule.
        const wait = failures > 0 ? connectRetryDelayMs(failures + attempt) : rejoinDelayMs(attempt);
        await new Promise((res) => window.setTimeout(res, wait));
        if (r.unmounted) return;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          await new Promise<void>((res) => {
            const done = () => {
              window.removeEventListener('online', done);
              res();
            };
            window.addEventListener('online', done);
            window.setTimeout(done, 10_000);
          });
          continue;
        }
        let res: Response | null = null;
        try {
          res = await roomFetch(code, '/token');
        } catch {
          res = null;
        }
        if (!res) continue;
        const outcome = rejoinOutcome(res.status);
        if (outcome === 'retry') continue;
        const body = await res.json().catch(() => ({}));
        if (outcome === 'ended') {
          noteClassEnded(code);
          setClassEnded(true);
          setTokenData(null);
          return;
        }
        if (outcome === 'stop') {
          setError(body.error || 'Could not rejoin the class');
          setTokenData(null);
          return;
        }
        await sleepConnectDelay(body);
        if (r.unmounted) return;
        everConnectedRef.current = false;
        setMediaProfile(parseMediaProfile(body.mediaProfile));
        setTokenData(body);
        connectedAtRef.current = Date.now();
        setConnKey((k) => k + 1);
        return;
      }
    } finally {
      r.running = false;
      setRejoining(false);
    }
  }, [code]);

  const onDisconnected = useCallback(
    (reason?: DisconnectReason) => {
      const leaving = rejoinRef.current.unmounted || leavingNow();
      if (shouldAutoRejoin(reason, { leaving })) {
        void rejoin();
        return;
      }
      if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
        // Our own previous connection being evicted by this tab's rejoin: not another device.
        if (isOwnStaleDuplicate({ rejoining: rejoinRef.current.running, connectedAt: connectedAtRef.current, now: Date.now() })) return;
        if (!isTeacher) {
          setFinished((f) => f ?? 'replaced');
          setTokenData(null);
        } else {
          setHandoff((h) => h ?? 'device');
          setTokenData(null);
          window.dispatchEvent(new Event(SESSION_CHECK_EVENT));
        }
        return;
      }
      if (reason === DisconnectReason.PARTICIPANT_REMOVED && isTeacher) {
        // Only a newer sign-in removes the teacher from the SFU (sessionKick).
        setHandoff((h) => h ?? 'device');
        setTokenData(null);
        window.dispatchEvent(new Event(SESSION_CHECK_EVENT));
        return;
      }
      // Room deletion under load often arrives as PARTICIPANT_REMOVED. One
      // cached /state read decides ended vs removed. Never call it a kick
      // until that probe says the student was removed from a live class.
      if (!isTeacher && (reason === DisconnectReason.PARTICIPANT_REMOVED || reason === DisconnectReason.ROOM_DELETED)) {
        const roomDeleted = reason === DisconnectReason.ROOM_DELETED;
        const participantRemoved = reason === DisconnectReason.PARTICIPANT_REMOVED;
        void (async () => {
          try {
            if (classEndedNoted(code)) {
              noteClassEnded(code);
              setFinished((f) => preferFinish(f, 'ended'));
              setClassEnded(true);
              setTokenData(null);
              return;
            }
            const probed = await onceCached({
              key: `end:${code}`,
              now: Date.now(),
              ttlMs: 15_000,
              cache: endProbeCache,
              inflight: endProbeInflight,
              load: async () => {
                const res = await roomFetch(code, '/state');
                const body = (await res.json().catch(() => null)) as ProbeBody;
                return { httpStatus: res.status, body };
              },
            });
            const verdict = verdictFromProbe({
              httpStatus: probed.httpStatus,
              body: probed.body,
              roomDeleted,
              participantRemoved,
              sawClassEnded: classEndedNoted(code),
              leaving: leavingNow(),
            });
            if (verdict === 'ended') {
              noteClassEnded(code);
              setFinished((f) => preferFinish(f, 'ended'));
              setClassEnded(true);
              setTokenData(null);
            } else if (verdict === 'removed') {
              setFinished((f) => (f && f !== 'removed' ? f : 'removed'));
              setTokenData(null);
            } else if (verdict === 'replaced') {
              setFinished((f) => f ?? 'replaced');
              setTokenData(null);
            } else if (verdict === 'rejoin') {
              void rejoin();
            }
          } catch (e) {
            console.warn('disconnect settle', e);
            if (roomDeleted || classEndedNoted(code)) {
              noteClassEnded(code);
              setFinished((f) => preferFinish(f, 'ended'));
              setClassEnded(true);
              setTokenData(null);
            } else {
              void rejoin();
            }
          }
        })();
      }
    },
    [isTeacher, rejoin, code]
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

  const [endedSessionId, setEndedSessionId] = useState<string | null>(null);
  const markEnded = useCallback((classSessionId: string | null) => {
    setClassEnded(true);
    if (classSessionId) setEndedSessionId(classSessionId);
    setTokenData(null);
  }, []);
  const finish = useCallback((r: FinishReason) => {
    setFinished((f) => f ?? r);
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

    // Students: fetch the media token in parallel with the first /state
    // (one round trip less on the join path; run-4 profiling). A waiting
    // student's token request just fails with 403 and is ignored.
    const tokEarly = tabRole === 'student' ? roomFetch(code, '/token').catch(() => null) : null;
    const stateRes = await roomFetch(code, '/state');
    const state = await stateRes.json();
    if (!stateRes.ok) {
      if (stateRes.status === 410 || state.ended) {
        noteClassEnded(code);
        setClassEnded(true);
        return;
      }
      setError(state.error || 'Room error');
      return;
    }
    if (state.status === 'ENDED' || state.ended) {
      noteClassEnded(code);
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

    const early = tokEarly ? await tokEarly : null;
    const tokRes = early && early.ok ? early : await roomFetch(code, '/token');
    const tok = await tokRes.json();
    if (!tokRes.ok) {
      if (tokRes.status === 410 || tok.ended) {
        noteClassEnded(code);
        setClassEnded(true);
        return;
      }
      setError(tok.error || 'Could not get media token');
      return;
    }
    // Join-wave pacing slot from the server (students only; 0 when quiet).
    await sleepConnectDelay(tok);
    setMediaProfile(parseMediaProfile(tok.mediaProfile));
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

  const endedAnyway = classEnded || classEndedNoted(code);
  const shownFinish: FinishReason | null = finished === 'removed' && endedAnyway ? 'ended' : finished;
  if (shownFinish || (endedAnyway && !isTeacher && getClassroomRole(code) === 'student')) {
    return (
      <StudentFinished
        reason={shownFinish ?? 'ended'}
        code={code}
        offerFeedback={Boolean(schoolStudent && (shownFinish === 'ended' || (endedAnyway && !shownFinish)))}
        schoolStudent={!!schoolStudent}
      />
    );
  }

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
    const endCopy = classEndedCopy(isTeacher);
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6" data-finished="ended">
        <div className="max-w-md rounded-2xl border border-white/10 bg-surface-1 p-8 text-center shadow-lift">
          <p className="font-display text-2xl font-semibold tracking-tight">{endCopy.title}</p>
          <p className="mt-2 text-sm text-slate-400">{endCopy.body}</p>
          {isTeacher && endedSessionId && <TeacherClassSummary classSessionId={endedSessionId} />}
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button variant={isTeacher ? 'primary' : 'secondary'} onClick={() => void goHomeAfterEnd()}>
              {isTeacher ? 'Dashboard' : 'Home'}
            </Button>
            {isTeacher && (
              <Button variant="secondary" onClick={() => router.push('/teacher/attendance')}>
                Attendance
              </Button>
            )}
          </div>
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
      key={connKey}
      token={tokenData.token}
      serverUrl={tokenData.url}
      connect
      video={false}
      audio={false}
      options={{
        // Minimizing the window must not drop the room. pagehide is how some
        // browsers report that; the socket still closes if the tab is destroyed.
        // Teachers: minimizing must not drop the room (pagehide on some browsers).
        // Students: tab close must send leave so the roster drops in ~5s, not ~23s.
        disconnectOnPageLeave: !isTeacher,
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
        // Jittered exponential backoff: a mass drop must not retry in lockstep.
        reconnectPolicy: classroomReconnectPolicy(),
        // Per-track options in SelectivePublisher / screen share override these.
        publishDefaults: {
          simulcast: false,
          backupCodec: false,
          dtx: true,
          red: true,
          audioPreset: AudioPresets.speech,
          videoEncoding: studentCamera().encoding,
          screenShareEncoding: screenShare().encoding,
        },
      }}
      // Students never auto-subscribe: StudentMediaPrivacy subscribes them to
      // the teacher's tracks and classmates' microphones only, never to other
      // students' cameras. The teacher keeps auto-subscribe (sampled cameras).
      connectOptions={{ peerConnectionTimeout: 20_000, autoSubscribe: isTeacher }}
      className="h-[100dvh] overflow-hidden"
      onConnected={() => {
        everConnectedRef.current = true;
        connectFailuresRef.current = 0;
      }}
      onError={(e) => {
        console.error('LiveKit', e);
        // Join wave: the first connect (or its negotiation) timed out. Retry
        // quickly with a fresh token instead of leaving the student stuck.
        // Retry with a fresh token (and a fresh pacing slot) after a backoff that
        // grows with each consecutive failure, so an overloaded SFU is not hammered.
        if (!everConnectedRef.current && (isNegotiationError(e) || e?.name === 'ConnectionError')) {
          connectFailuresRef.current += 1;
          void rejoin({ connectFailures: connectFailuresRef.current });
        }
      }}
      onDisconnected={onDisconnected}
    >
      {!isTeacher && <StudentLeaveOnPageHide />}
      <ReconnectWatchdog onStuck={() => void rejoin()} />
      {rejoining && (
        <div className="pointer-events-none fixed left-1/2 top-2 z-[80] -translate-x-1/2 rounded-full bg-amber-500/90 px-3 py-1 text-xs font-semibold text-black" data-testid="rejoining">
          Reconnecting to class…
        </div>
      )}
      <RoomInner
        code={code}
        isTeacher={isTeacher}
        canPublishVideo={canPublishVideo}
        mutedByTeacher={tokenData.mutedByTeacher}
        visibleIdentities={tokenData.visibleIdentities}
        displayName={displayName}
        onVisibilityChange={setCanPublishVideo}
        onClassEnded={markEnded}
        onFinished={finish}
      />
    </LiveKitRoom>
  );
}

/** Pages that are navigating away (Leave / End) mark this so the disconnect is not treated as a drop. */
function leavingNow(): boolean {
  try {
    return (window as Window & { __classroomLeaving?: boolean }).__classroomLeaving === true;
  } catch {
    return false;
  }
}

/**
 * Tears the room down when LiveKit is stuck reconnecting (peer connections
 * left in "new" after a long drop) so the outer component rejoins with a new
 * Room. Also rejoins when the browser comes back online while disconnected.
 */
/**
 * Tab close / navigation: send LiveKit leave immediately. Minimizing uses
 * visibilitychange (not pagehide with persisted=false) on desktop; a brief
 * reconnect after a refresh is absorbed by STUDENT_GONE_GRACE_MS.
 */
function StudentLeaveOnPageHide() {
  const room = useRoomContext();
  useEffect(() => {
    if (!room) return;
    const onHide = (e: PageTransitionEvent) => {
      if (e.persisted) return;
      void room.disconnect(true).catch(() => undefined);
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [room]);
  return null;
}

function ReconnectWatchdog({ onStuck }: { onStuck: () => void }) {
  const room = useRoomContext();
  const cb = useRef(onStuck);
  cb.current = onStuck;
  useEffect(() => {
    if (!room) return;
    let since: number | null = null;
    const iv = window.setInterval(() => {
      const st = room.state;
      const busy = st === ConnectionState.Reconnecting || st === ConnectionState.SignalReconnecting;
      if (!busy) {
        since = null;
        return;
      }
      since ??= Date.now();
      if (Date.now() - since > STUCK_RECONNECT_MS) {
        since = null;
        void room.disconnect(false).catch(() => undefined);
        cb.current();
      }
    }, 2000);
    const onOnline = () => {
      if (room.state === ConnectionState.Disconnected) cb.current();
    };
    window.addEventListener('online', onOnline);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener('online', onOnline);
    };
  }, [room]);
  return null;
}

/**
 * Teacher's finished screen: when the class ran, and who came, from the same
 * report the attendance page uses. One request; nothing shows if it fails.
 */
function TeacherClassSummary({ classSessionId }: { classSessionId: string }) {
  const [facts, setFacts] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch(`/api/teacher/attendance/sessions?sessionId=${encodeURIComponent(classSessionId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { rows?: ClassSummaryRow[] } | null) => {
        const row = d?.rows?.[0];
        if (alive && row) setFacts(classSummaryFacts(row));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [classSessionId]);
  if (!facts) return null;
  return (
    <ul className="mt-4 space-y-1 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left text-sm text-slate-200" data-testid="class-summary">
      {facts.map((f) => (
        <li key={f}>{f}</li>
      ))}
    </ul>
  );
}

/**
 * Static end screen for students. Rendering it unmounted LiveKitRoom and
 * RoomInner (LiveKit disconnected, tracks stopped, polls and listeners gone);
 * it makes no requests itself. window.close() works when the tab was opened
 * by the school app; otherwise the student closes it.
 */
function StudentFinished({
  reason,
  code,
  offerFeedback,
  schoolStudent,
}: {
  reason: FinishReason;
  code: string;
  offerFeedback?: boolean;
  schoolStudent?: boolean;
}) {
  // Item 7: only students still in class when it ended get the form; the
  // server decides (a student who left mid-class gets the plain screen).
  const [eligible, setEligible] = useState<boolean | null>(offerFeedback && reason === 'ended' ? null : false);
  useEffect(() => {
    if (eligible !== null) return;
    let alive = true;
    void roomFetch(code, '/feedback')
      .then((r) => r.json())
      .then((d: { eligible?: boolean }) => alive && setEligible(!!d.eligible))
      .catch(() => alive && setEligible(false));
    return () => {
      alive = false;
    };
  }, [code, eligible]);
  const showForm = eligible === true;
  const [formDone, setFormDone] = useState(false);
  useEffect(() => {
    window.dispatchEvent(new Event(CLASS_FINISHED_EVENT));
  }, []);
  useEffect(() => {
    // A student who left can rejoin, so that screen stays open.
    if ((showForm && !formDone) || eligible === null || reason === 'left') return;
    try {
      window.close();
    } catch {
      /* blocked: the screen stays */
    }
  }, [showForm, formDone, eligible, reason]);
  const copy = finishCopy(reason);
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6" data-finished={reason}>
      <div className="max-w-md rounded-2xl border border-white/10 bg-surface-1 p-8 text-center shadow-lift">
        <p className="font-display text-2xl font-semibold tracking-tight">{copy.title}</p>
        <p className="mt-2 text-sm text-slate-400">{copy.body}</p>
        {showForm && !formDone && <FeedbackForm code={code} onDone={() => setFormDone(true)} />}
        {reason === 'left' && (
          <a
            href={schoolStudent ? '/student' : `/join/${code}`}
            className="btn-primary mt-5 inline-flex px-4 py-2 text-sm"
            data-testid="rejoin-class"
          >
            Rejoin class
          </a>
        )}
      </div>
    </main>
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

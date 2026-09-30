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
  createLocalVideoTrack,
  createLocalAudioTrack,
  LocalAudioTrack,
  RoomEvent,
  ConnectionState,
  AudioPresets,
  type LocalTrackPublication,
  type Participant,
  type TrackPublication,
} from 'livekit-client';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useRouter } from 'next/navigation';
import { useRoomState } from '@/hooks/useRoomState';
import { Controls } from './Controls';
import { LocalPreview } from './LocalPreview';
import { ChatView, useChatThread } from './Chat';
import { FloatingPanel } from './FloatingPanel';
import { ScreenAnnotator, useScreenAnnotate, ANNOTATE_COLORS, type AnnotateMode } from './ScreenAnnotator';
import {
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
import { roomFetch, rememberClassroomRole, getClassroomRole, claimTeacherTab } from '@/lib/classroomClient';

type TokenPayload = {
  token: string;
  url: string;
  identity: string;
  canPublishVideo: boolean;
  visibleIdentities: string[];
  mutedByTeacher: boolean;
};

function isTeacherParticipant(
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
}: {
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
    // Students only see the teacher's screen; teachers see all shares
    if (!isTeacher && !t.participant.isLocal) {
      return isTeacherParticipant(t.participant, teacherSet);
    }
    return true;
  });

  const cameras = tracks.filter((t) => {
    if (t.source !== Track.Source.Camera || t.participant.isLocal) return false;
    // Students: only teacher remote videos — never other students
    if (!isTeacher) {
      return isTeacherParticipant(t.participant, teacherSet);
    }
    return true;
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
              ? 'When someone shares a camera or screen, it will appear here.'
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
          {screenShares.map((t) => (
            <TeacherShareTile
              key={`${t.participant.identity}-${t.source}`}
              trackRef={t}
              canAnnotate={!!isTeacher && !!t.participant.isLocal && !!annotate}
              annotate={annotate}
              annotateOn={!!annotateOn}
              annotateMode={annotateMode || 'pen'}
              annotateColor={annotateColor || ANNOTATE_COLORS[0]}
            />
          ))}
        </div>
      )}

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

function TeacherScreenStage({
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


type FloatPos = { x: number; y: number };

function clampFloatPos(
  x: number,
  y: number,
  w: number,
  h: number,
  topReserve = 8,
  bottomReserve = 108
): FloatPos {
  const margin = 8;
  const maxX = Math.max(margin, window.innerWidth - w - margin);
  const maxY = Math.max(topReserve, window.innerHeight - h - bottomReserve);
  return {
    x: Math.min(maxX, Math.max(margin, x)),
    y: Math.min(maxY, Math.max(topReserve, y)),
  };
}

function useDraggableFloat(
  storageKey: string,
  defaultPos: () => FloatPos,
  sizeRef: RefObject<{ w: number; h: number }>,
  topReserve = 8,
  bottomReserve = 108
) {
  const [pos, setPos] = useState<FloatPos | null>(null);
  const dragging = useRef(false);
  const origin = useRef({ px: 0, py: 0, x: 0, y: 0 });

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as FloatPos;
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
          const sz = sizeRef.current || { w: 186, h: 105 };
          setPos(clampFloatPos(parsed.x, parsed.y, sz.w, sz.h, topReserve, bottomReserve));
          return;
        }
      }
    } catch {
      /* ignore */
    }
    setPos(defaultPos());
  }, [storageKey, topReserve, bottomReserve]);

  const reclamp = useCallback(() => {
    setPos((prev) => {
      if (!prev) return prev;
      const sz = sizeRef.current || { w: 186, h: 105 };
      const next = clampFloatPos(prev.x, prev.y, sz.w, sz.h, topReserve, bottomReserve);
      if (next.x === prev.x && next.y === prev.y) return prev;
      return next;
    });
  }, [sizeRef, topReserve, bottomReserve]);

  useEffect(() => {
    const onResize = () => {
      reclamp();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [reclamp]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('button, select, input, a')) return;
      e.preventDefault();
      e.stopPropagation();
      const cur = pos || defaultPos();
      dragging.current = true;
      origin.current = { px: e.clientX, py: e.clientY, x: cur.x, y: cur.y };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [pos, defaultPos]
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - origin.current.px;
      const dy = e.clientY - origin.current.py;
      const sz = sizeRef.current || { w: 186, h: 105 };
      const next = clampFloatPos(
        origin.current.x + dx,
        origin.current.y + dy,
        sz.w,
        sz.h,
        topReserve,
        bottomReserve
      );
      setPos(next);
    },
    [sizeRef, topReserve, bottomReserve]
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent) => {
      if (!dragging.current) return;
      dragging.current = false;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      setPos((prev) => {
        if (!prev) return prev;
        try {
          sessionStorage.setItem(storageKey, JSON.stringify(prev));
        } catch {
          /* ignore */
        }
        return prev;
      });
    },
    [storageKey]
  );

  return {
    pos,
    reclamp,
    dragHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
  };
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
    video: {
      frameRate: { ideal: 15, max: 30 },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: false as const,
    selfBrowserSurface: 'include',
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
/** Above the teacher dock. The share bar is no longer in this page. */
const PEER_BOTTOM_RESERVE = 120;

function peerFloatLayout(slots: 2 | 4 | 6, vw: number, vh: number) {
  const cols = slots === 6 ? 2 : 1;
  const rows = slots === 2 ? 2 : slots === 4 ? 4 : 3;
  const header = 34;
  const pad = 16;
  const gap = 6;
  const border = 2;
  const bottomReserve = PEER_BOTTOM_RESERVE;
  const maxPaneW = Math.max(200, vw - 16);
  const maxPaneH = Math.max(180, vh - PEER_TOP_RESERVE - bottomReserve);
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
  const sizeRef = useRef({ w: 360, h: 160 });
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

  const defaultPos = useCallback((): FloatPos => {
    const w = sizeRef.current.w;
    const h = sizeRef.current.h;
    return clampFloatPos(window.innerWidth - w - 12, window.innerHeight - h - 100, w, h);
  }, []);

  const { pos, reclamp, dragHandlers } = useDraggableFloat(
    `teacher_cam_pos_${roomCode.toUpperCase()}`,
    defaultPos,
    sizeRef
  );

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
    const el = paneRef.current;
    if (!el) return;
    const sync = () => {
      sizeRef.current = { w: el.offsetWidth || 186, h: el.offsetHeight || 105 };
      reclamp();
    };
    sync();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [reclamp, paneMin, selfMode]);

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
      aria-label="Videos — drag to move"
      title="Drag to move"
      {...dragHandlers}
    >
      {paneMin ? (
        <div className="student-media-restore">
          <span>Videos</span>
          <button type="button" className="student-media-btn" onClick={() => setPaneMin(false)}>
            Show videos
          </button>
        </div>
      ) : (
        <>
          <div className="student-media-head">
            <span className="student-media-title">Videos</span>
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
}: {
  roomCode: string;
  teacherIdentities: string[];
  visibleIdentities: string[];
  selfName: string;
  selfStream: MediaStream | null;
  /** Student-camera count that fills this window (tiles minus the teacher). */
  onSlotsChange?: (studentSlots: number) => void;
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
  const [rotationTick, setRotationTick] = useState(0);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [stickyVersion, setStickyVersion] = useState(0);
  const [tick, setTick] = useState(0);
  const [viewport, setViewport] = useState({ w: 1400, h: 900 });

  const layout = useMemo(
    () => peerFloatLayout(slotCount, viewport.w, viewport.h),
    [slotCount, viewport.w, viewport.h]
  );
  sizeRef.current = minimized
    ? { w: 168, h: 36 }
    : { w: layout.paneW, h: layout.paneH };

  const defaultPos = useCallback((): FloatPos => {
    const w = sizeRef.current.w;
    const h = sizeRef.current.h;
    return clampFloatPos(12, window.innerHeight - h - PEER_BOTTOM_RESERVE, w, h, PEER_TOP_RESERVE);
  }, []);

  const { pos, reclamp, dragHandlers } = useDraggableFloat(
    `peers_float_pos_${roomCode.toUpperCase()}`,
    defaultPos,
    sizeRef,
    PEER_TOP_RESERVE,
    PEER_BOTTOM_RESERVE
  );

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
      const h = el.offsetHeight || (minimized ? 36 : layout.paneH);
      sizeRef.current = { w, h };
      reclamp();
    };
    sync();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [layout.paneW, layout.paneH, minimized, reclamp]);

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

  const style: CSSProperties = pos
    ? { left: pos.x, top: pos.y }
    : { left: 12, top: PEER_TOP_RESERVE };
  if (!minimized) {
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
      data-minimized={minimized ? '1' : '0'}
      style={style}
      aria-label="Class videos — drag to move"
      {...dragHandlers}
    >
      <div className="peers-float-header">
        <span className="text-2xs font-semibold text-slate-200">
          Class{minimized ? ` · ${peerIds.length + 1}` : ''}
        </span>
        <div className="flex items-center gap-1" data-no-drag onPointerDown={(e) => e.stopPropagation()}>
          {!minimized &&
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
            onClick={() => setMinimized((v) => !v)}
            aria-label={minimized ? 'Expand class videos' : 'Minimize class videos'}
            title={minimized ? 'Expand' : 'Minimize'}
          >
            {minimized ? '▢' : '—'}
          </button>
        </div>
      </div>
      {!minimized && (
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


function createCanvasCameraTrack(): { track: LocalVideoTrack; stopExtra: () => void } {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unsupported');
  let frame = 0;
  const draw = () => {
    frame += 1;
    const g = ctx.createLinearGradient(0, 0, 640, 360);
    g.addColorStop(0, '#1e3a5f');
    g.addColorStop(1, '#0f172a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.arc(320 + Math.sin(frame / 18) * 90, 170, 52, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 26px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Teacher', 320, 270);
    ctx.font = '14px system-ui, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('Demo camera (no webcam)', 320, 298);
  };
  draw();
  const timer = window.setInterval(draw, 66);
  const stream = canvas.captureStream(15);
  const mediaTrack = stream.getVideoTracks()[0];
  if (!mediaTrack) {
    clearInterval(timer);
    throw new Error('no canvas video track');
  }
  const track = new LocalVideoTrack(mediaTrack);
  return {
    track,
    stopExtra: () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
    },
  };
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

function SelectivePublisher({
  canPublishVideo,
  mutedByTeacher,
  camDesired,
  micDesired,
  localCamStream,
  setLocalCamStream,
}: {
  canPublishVideo: boolean;
  mutedByTeacher: boolean;
  camDesired: boolean;
  micDesired: boolean;
  localCamStream: MediaStream | null;
  setLocalCamStream: (s: MediaStream | null) => void;
}) {
  const { localParticipant } = useLocalParticipant();
  const room = useRoomContext();
  const camTrackRef = useRef<LocalVideoTrack | null>(null);
  const camStopExtraRef = useRef<(() => void) | null>(null);
  const micTrackRef = useRef<LocalAudioTrack | null>(null);
  const publishingVideo = useRef(false);
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
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 360, frameRate: 15 },
            audio: false,
          });
        } catch (deviceErr) {
          console.warn('local webcam unavailable, demo canvas preview', deviceErr);
          const canvas = document.createElement('canvas');
          canvas.width = 640;
          canvas.height = 360;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.fillStyle = '#0f172a';
            ctx.fillRect(0, 0, 640, 360);
            ctx.fillStyle = '#38bdf8';
            ctx.font = '20px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Demo camera', 320, 180);
          }
          stream = canvas.captureStream(5);
        }
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        setLocalCamStream(stream);
      } catch (e) {
        console.warn('local camera', e);
      }
    }

    setupLocal();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camDesired]);

  useEffect(() => {
    if (!localParticipant || !room) return;
    const gen = ++videoGen.current;
    const shouldPublish = camDesired && canPublishVideo;
    const participant = localParticipant;

    void enqueueLocalPublish(async () => {
        if (gen !== videoGen.current) return;

        if (!shouldPublish) {
          const track = camTrackRef.current;
          const extra = camStopExtraRef.current;
          camTrackRef.current = null;
          camStopExtraRef.current = null;
          publishingVideo.current = false;
          if (track) {
            await unpublishThenStop(participant, track);
            try {
              extra?.();
            } catch {
              /* canvas preview already stopped */
            }
          }
          return;
        }

        const existingCam = participant.getTrackPublication(Track.Source.Camera);
        if (existingCam?.track && camTrackRef.current) {
          publishingVideo.current = true;
          return;
        }
        if (publishingVideo.current && !existingCam?.track) {
          publishingVideo.current = false;
          const stale = camTrackRef.current;
          camTrackRef.current = null;
          safeStop(stale);
        }

        let stopExtra: (() => void) | null = null;
        let track: LocalVideoTrack | null = null;
        try {
          publishingVideo.current = true;
          try {
            track = await createLocalVideoTrack({
              resolution: { width: 640, height: 360 },
              frameRate: 15,
            });
          } catch (deviceErr) {
            console.warn('webcam unavailable, using demo canvas camera', deviceErr);
            const fallback = createCanvasCameraTrack();
            track = fallback.track;
            stopExtra = fallback.stopExtra;
          }
          if (!track) {
            publishingVideo.current = false;
            return;
          }
          // A newer sample decision arrived while the camera was opening. Drop this track
          // and let that decision publish, instead of negotiating twice at once.
          if (gen !== videoGen.current) {
            safeStop(track);
            try {
              stopExtra?.();
            } catch {
              /* canvas preview already stopped */
            }
            publishingVideo.current = false;
            return;
          }
          await participant.publishTrack(track, {
            source: Track.Source.Camera,
            simulcast: false,
            videoEncoding: { maxBitrate: 400_000, maxFramerate: 15 },
          });
          if (gen !== videoGen.current) {
            await unpublishThenStop(participant, track);
            try {
              stopExtra?.();
            } catch {
              /* canvas preview already stopped */
            }
            publishingVideo.current = false;
            return;
          }
          camTrackRef.current = track;
          camStopExtraRef.current = stopExtra;
        } catch (e) {
          publishingVideo.current = false;
          if (track && camTrackRef.current !== track) {
            try {
              await unpublishThenStop(participant, track);
            } catch {
              /* publication already gone */
            }
          }
          try {
            stopExtra?.();
          } catch {
            /* canvas preview already stopped */
          }
          console.warn('publish video', e);
        }
      });
  }, [canPublishVideo, camDesired, localParticipant, room]);

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
  const [camOn, setCamOn] = useState(true);
  const [screenOn, setScreenOn] = useState(false);
  const [chatUnread, setChatUnread] = useState(0);
  const [localCamStream, setLocalCamStream] = useState<MediaStream | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [hudChatOpen, setHudChatOpen] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [leftForFullscreen, setLeftForFullscreen] = useState(false);
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
  const visibles = state?.visibleIdentities ?? visibleIdentities;

  useEffect(() => {
    if (effectiveMuted) setMicOn(false);
  }, [effectiveMuted]);

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

  // Student forced fullscreen: request on join; leaving fullscreen kicks from class
  useEffect(() => {
    if (isTeacher || leftForFullscreen) return;
    const root = document.documentElement;
    let entered = false;
    let cancelled = false;
    let kicking = false;

    const requestFs = async () => {
      if (cancelled || !root.requestFullscreen) return;
      try {
        if (!document.fullscreenElement) {
          await root.requestFullscreen();
        }
        if (document.fullscreenElement) entered = true;
      } catch {
        // Browser blocked / needs gesture / unsupported — do not kick
      }
    };

    void requestFs();

    const onGesture = () => {
      if (!entered && !document.fullscreenElement) void requestFs();
    };

    const onFsChange = () => {
      if (cancelled || isTeacher || kicking) return;
      if (document.fullscreenElement) {
        entered = true;
        return;
      }
      // Only kick if we previously succeeded at entering fullscreen
      if (!entered) return;
      kicking = true;
      setLeftForFullscreen(true);
      void (async () => {
        try {
          await roomFetch(code, '/leave', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          });
        } catch {
          /* ignore */
        }
        try {
          room?.disconnect();
        } catch {
          /* ignore */
        }
        router.push('/');
      })();
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
  }, [isTeacher, leftForFullscreen, code, room, router]);


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
    shareHideCleanup.current = () => {
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
    const pending = beginShareControls();
    void pending.then((surface) => {
      if (!shareWantedRef.current) {
        surface?.close();
        return;
      }
      if (!surface) {
        setHudNotice(
          'The browser blocked the share controls window. Allow pop-ups for this site, then try Open share controls again.'
        );
        return;
      }
      attachShareSurface(surface);
      setHudNotice('');
    });
  }, [attachShareSurface]);

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

    shareWantedRef.current = true;
    try {
      const published = new LocalVideoTrack(media, undefined, true);
      await enqueueLocalPublish(async () => {
        await localParticipant.publishTrack(published, {
          name: 'screen',
          source: Track.Source.ScreenShare,
          simulcast: false,
          screenShareEncoding: { maxBitrate: 1_500_000, maxFramerate: 15 },
        });
      });
    } catch (e) {
      shareWantedRef.current = false;
      shareStartRef.current = false;
      try {
        media.stop();
      } catch {
        /* ignore */
      }
      const controls = await controlsPromise.catch(() => null);
      controls?.close();
      console.warn('screen share', e);
      setScreenOn(false);
      setHudNotice(screenShareErrorMessage(e));
      return;
    }

    const controls = await controlsPromise.catch(() => null);
    attachShareSurface(controls);
    if (!controls) {
      setHudNotice(
        'Screen is sharing, but the browser blocked the controls window. Allow pop-ups, then use Open share controls.'
      );
    }
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
      if (effectiveMuted && !isTeacher) return;
      setMicOn((v) => !v);
    },
    onToggleCam: () => setCamOn((v) => !v),
    onToggleScreen: toggleScreen,
    onLeave: leave,
    isTeacher,
    canPublishVideo: effectiveCanPublish,
    mutedByTeacher: effectiveMuted,
    showScreenShare: isTeacher,
    handRaised,
    onToggleHand: isTeacher ? undefined : toggleHand,
  };

  // —— Student path: always fullscreen stage + floating teacher cam + float chrome ——
  if (!isTeacher) {
    const teacherHere = teacherIdentities.length > 0;
    const badge =
      effectiveStage === 'screen'
        ? 'Teacher screen'
        : teacherHere
          ? 'Teacher is in the room'
          : 'Waiting for teacher…';

    return (
      <div className="stage-fullscreen">
        <SelectivePublisher
          canPublishVideo={effectiveCanPublish}
          mutedByTeacher={effectiveMuted}
          camDesired={camOn}
          micDesired={micOn}
          localCamStream={localCamStream}
          setLocalCamStream={setLocalCamStream}
        />
        <RoomAudioRenderer />

        <div className="stage-fullscreen-badge">{badge}</div>

        <div className="absolute inset-0 z-10">
          {effectiveStage === 'screen' ? (
            <TeacherScreenStage
              teacherIdentities={teacherIdentities}
              code={code}
              active={effectiveStage === 'screen'}
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

        <div className="stage-float-chrome">
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
          storageKey={`student_chat_${code.toUpperCase()}`}
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
        canPublishVideo={effectiveCanPublish}
        mutedByTeacher={effectiveMuted}
        camDesired={camOn}
        micDesired={micOn}
        localCamStream={localCamStream}
        setLocalCamStream={setLocalCamStream}
      />
      <RoomAudioRenderer />

      {/* Top bar */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] bg-surface-1/80 px-3 py-2.5 backdrop-blur-xl sm:px-4">
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
          <h1 className="mt-0.5 truncate font-display text-lg font-semibold tracking-tight sm:text-xl">
            {state?.name || 'Classroom'}
          </h1>
          <p className="truncate text-2xs text-slate-400 sm:text-xs">
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

        <div className="flex items-center gap-1.5 sm:gap-2">
          {isTeacher && screenOn && !shareMount && (
            <Button variant="primary" size="sm" onClick={() => reopenShareControls()}>
              <IconScreen size={14} />
              Open share controls
            </Button>
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

      {/* Main stage — screen share fills the middle when active */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
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
                  ? 'flex h-full min-h-0 flex-col'
                  : 'flex min-h-0 flex-col gap-3 pb-2'
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
          storageKey={`teacher_roster_${code.toUpperCase()}`}
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
            {waitingCount > 0 && (
              <div className="shrink-0 border-t border-white/5 pt-3" data-no-drag>
                <h3 className="text-2xs font-semibold uppercase tracking-wider text-slate-400">
                  Waiting ({waitingCount})
                </h3>
                <ul className="mt-2 max-h-32 space-y-1.5 overflow-y-auto text-sm">
                  {state!.waiting!.map((p) => (
                    <li
                      key={p.id}
                      className="flex items-center justify-between gap-2 rounded-lg bg-black/15 px-2 py-1.5"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <Avatar name={p.displayName} size="sm" />
                        <span className="truncate">{p.displayName}</span>
                      </div>
                      <button
                        type="button"
                        className="shrink-0 text-xs font-semibold text-brand-300 hover:underline"
                        onClick={async () => {
                          await roomFetch(code, '/admit', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ participantIds: [p.id] }),
                          });
                          refresh();
                        }}
                      >
                        Admit
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </FloatingPanel>

        <FloatingPanel
          title="Chat"
          storageKey={`teacher_chat_${code.toUpperCase()}`}
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
      />

      {/* Controls render only inside the pop-out. Nothing is painted here. */}
      {isTeacher && shareMount && (
        <TeacherShareHud
          host={shareMount}
          hostWindow={shareWindow}
          admitted={state?.admitted ?? []}
          waiting={(state?.waiting ?? []).map((w) => ({
            id: w.id,
            displayName: w.displayName,
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
          notice={hudNotice || undefined}
        />
      )}

      {/* Bottom dock — never covers content */}
      <footer className="shrink-0 border-t border-white/[0.06] bg-surface-1/90 px-3 py-2.5 backdrop-blur-xl sm:px-4">
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
        publishDefaults: {
          simulcast: false,
          backupCodec: false,
          dtx: true,
          red: true,
          audioPreset: AudioPresets.speech,
          videoEncoding: { maxBitrate: 400_000, maxFramerate: 15 },
          screenShareEncoding: { maxBitrate: 1_200_000, maxFramerate: 15 },
        },
      }}
      connectOptions={{ peerConnectionTimeout: 20_000 }}
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

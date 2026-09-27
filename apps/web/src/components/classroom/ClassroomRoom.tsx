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
  type Participant,
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
import { Whiteboard } from './Whiteboard';
import { Chat } from './Chat';
import { FloatingPanel } from './FloatingPanel';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageLoading } from '@/components/ui/Skeleton';
import { IconBoard, IconHand, IconScreen, IconUsers, IconVideo } from '@/components/ui/Icons';
import { cn } from '@/lib/cn';
import { roomFetch, rememberClassroomRole } from '@/lib/classroomClient';

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
}: {
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
            <div
              key={`${t.participant.identity}-${t.source}`}
              className="video-tile relative min-h-0 h-full w-full overflow-hidden bg-black"
            >
              {t.publication?.track ? (
                <VideoTrack trackRef={t} className="h-full w-full object-contain" />
              ) : (
                <div className="flex h-full items-center justify-center bg-ink-900 text-slate-400">
                  No screen
                </div>
              )}
              <div className="absolute bottom-2 left-2 flex items-center gap-2 rounded-lg bg-black/65 px-2.5 py-1 text-xs backdrop-blur">
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


function TeacherScreenStage({ teacherIdentities }: { teacherIdentities: string[] }) {
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
          {t.publication?.track ? (
            <VideoTrack trackRef={t} className="h-full w-full object-contain" />
          ) : (
            <div className="flex h-full items-center justify-center text-slate-400">No screen</div>
          )}
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
/** Below the classroom header and the whiteboard page menu. */
const PEER_TOP_RESERVE = 152;
/** Above the dock and the tldraw tool bar. */
const PEER_BOTTOM_RESERVE = 156;

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
}: {
  teacherIdentities: string[];
  roomCode: string;
}) {
  const room = useRoomContext();
  const teacherSet = new Set(teacherIdentities);
  const [tick, setTick] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const sizeRef = useRef({ w: 186, h: 105 });

  const defaultPos = useCallback((): FloatPos => {
    const w = sizeRef.current.w;
    const h = sizeRef.current.h;
    return clampFloatPos(window.innerWidth - w - 12, window.innerHeight - h - 100, w, h);
  }, []);

  const { pos, dragHandlers } = useDraggableFloat(
    `teacher_cam_pos_${roomCode.toUpperCase()}`,
    defaultPos,
    sizeRef
  );

  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const sync = () => {
      sizeRef.current = { w: el.offsetWidth || 186, h: el.offsetHeight || 105 };
    };
    sync();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

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
    room.on(RoomEvent.TrackSubscribed, ensure);
    room.on(RoomEvent.TrackUnsubscribed, bump);
    room.on(RoomEvent.ParticipantConnected, ensure);
    room.on(RoomEvent.ParticipantDisconnected, bump);
    room.on(RoomEvent.TrackSubscriptionFailed, ensure);
    const iv = window.setInterval(ensure, 1500);
    return () => {
      room.off(RoomEvent.TrackPublished, ensure);
      room.off(RoomEvent.TrackSubscribed, ensure);
      room.off(RoomEvent.TrackUnsubscribed, bump);
      room.off(RoomEvent.ParticipantConnected, ensure);
      room.off(RoomEvent.ParticipantDisconnected, bump);
      room.off(RoomEvent.TrackSubscriptionFailed, ensure);
      window.clearInterval(iv);
    };
  }, [room, teacherIdentities]);

  void tick;

  let teacherPub: { track?: { mediaStreamTrack?: MediaStreamTrack } | null; isSubscribed?: boolean } | null =
    null;
  let teacherName = 'Teacher';
  if (room) {
    for (const p of Array.from(room.remoteParticipants.values())) {
      if (!isTeacherParticipant(p, teacherSet)) continue;
      teacherName = p.name || p.identity || 'Teacher';
      teacherPub = p.getTrackPublication(Track.Source.Camera) ?? null;
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
  }, [mediaTrack]);

  const hasVideo = !!mediaTrack;
  const style = pos ? { left: pos.x, top: pos.y } : { right: 12, bottom: 88 };

  return (
    <div
      ref={paneRef}
      className="teacher-float-pane"
      style={style}
      aria-label="Teacher camera — drag to move"
      title="Drag to move"
      {...dragHandlers}
    >
      {hasVideo ? (
        <video
          ref={videoRef}
          className="pointer-events-none h-full w-full object-cover"
          autoPlay
          playsInline
          muted
        />
      ) : (
        <div className="pointer-events-none flex h-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-surface-3 to-ink-950 text-slate-300">
          <Avatar name={teacherName} size="lg" />
          <span className="text-xs">{teacherPub ? 'Camera off' : 'Waiting…'}</span>
        </div>
      )}
      {hasVideo && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-2.5 pb-2 pt-6">
          <span className="text-2xs font-semibold tracking-wide text-white">{teacherName}</span>
        </div>
      )}
    </div>
  );
}

function TeacherPeersFloat({
  roomCode,
  teacherIdentities,
  visibleIdentities,
}: {
  roomCode: string;
  teacherIdentities: string[];
  visibleIdentities: string[];
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
    for (const id of sticky) {
      if (slots.length >= slotCount) break;
      if (!slots.includes(id)) slots.push(id);
    }

    // Random mosaic fill among remaining eligible (non-sticky).
    // Reshuffle only on rotationTick change (or when pool membership drifts).
    const rest = pool.filter((id) => !slots.includes(id) && !sticky.includes(id));
    const prevMosaic = mosaicPoolRef.current.filter((id) => rest.includes(id));
    const needSlots = Math.max(0, slotCount - slots.length);
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
    // Fresh random order every ~8s (rotationTick), without reshuffling on unrelated ticks
    if (lastRotationTickRef.current !== rotationTick) {
      lastRotationTickRef.current = rotationTick;
      const shuffled = [...rest];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      mosaic = shuffled;
      mosaicPoolRef.current = mosaic;
    }

    for (const id of mosaic) {
      if (slots.length >= slotCount) break;
      slots.push(id);
    }
    // Never backfill with students who are not publishing a sample camera.
    // The grid still paints `slotCount` cells; the rest stay blank.
    return slots.slice(0, slotCount);
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

  const cells: Array<string | null> = [];
  for (let i = 0; i < slotCount; i++) cells.push(peerIds[i] ?? null);

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
      data-slots={slotCount}
      data-minimized={minimized ? '1' : '0'}
      style={style}
      aria-label="Students — drag to move"
      {...dragHandlers}
    >
      <div className="peers-float-header">
        <span className="text-2xs font-semibold text-slate-200">
          Students{minimized ? ` · ${peerIds.length}` : peerIds.length === 0 ? ' · waiting' : ''}
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
                onClick={() => setSlotCount(n)}
                aria-label={`Show ${n} videos`}
              >
                {n}
              </button>
            ))}
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] font-bold text-slate-300 hover:bg-white/10"
            onClick={() => setMinimized((v) => !v)}
            aria-label={minimized ? 'Expand students' : 'Minimize students'}
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
            if (!identity) {
              return (
                <div
                  key={`empty-${i}`}
                  className="peers-float-tile"
                  data-empty="1"
                  style={{ width: layout.tileW, height: layout.tileH }}
                  aria-hidden
                />
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
}: {
  name: string;
  mediaTrack: MediaStreamTrack | null;
  speaking: boolean;
  pinned: boolean;
  tileW: number;
  tileH: number;
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
          className="h-full w-full object-cover"
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
  const micTrackRef = useRef<LocalAudioTrack | null>(null);
  const publishingVideo = useRef(false);

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
    let cancelled = false;

    async function syncVideoPublish() {
      if (!localParticipant || !room) return;
      const shouldPublish = camDesired && canPublishVideo;

      if (!shouldPublish) {
        if (camTrackRef.current) {
          try {
            await localParticipant.unpublishTrack(camTrackRef.current);
          } catch {
            /* already unpublished */
          }
          camTrackRef.current.stop();
          camTrackRef.current = null;
        }
        publishingVideo.current = false;
        return;
      }

      const existingCam = localParticipant.getTrackPublication(Track.Source.Camera);
      if (existingCam?.track && camTrackRef.current) {
        publishingVideo.current = true;
        return;
      }
      if (publishingVideo.current && camTrackRef.current && existingCam?.track) return;
      // Stale publish flag after a failed/replaced track — allow retry
      if (publishingVideo.current && !existingCam?.track) {
        publishingVideo.current = false;
        camTrackRef.current = null;
      }

      let stopExtra: (() => void) | null = null;
      try {
        publishingVideo.current = true;
        let track: LocalVideoTrack;
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
        if (cancelled || !(camDesired && canPublishVideo)) {
          track.stop();
          stopExtra?.();
          publishingVideo.current = false;
          return;
        }
        await localParticipant.publishTrack(track, { source: Track.Source.Camera });
        camTrackRef.current = track;
      } catch (e) {
        publishingVideo.current = false;
        stopExtra?.();
        console.warn('publish video', e);
      }
    }

    syncVideoPublish();
    return () => {
      cancelled = true;
    };
  }, [canPublishVideo, camDesired, localParticipant, room]);

  useEffect(() => {
    let cancelled = false;
    async function syncMic() {
      if (!localParticipant) return;
      // Teacher mute is authoritative — never publish audio while mutedByTeacher
      const want = micDesired && !mutedByTeacher;
      if (!want) {
        if (micTrackRef.current) {
          try {
            await localParticipant.unpublishTrack(micTrackRef.current);
          } catch {
            /* already unpublished */
          }
          micTrackRef.current.stop();
          micTrackRef.current = null;
        }
        try {
          await localParticipant.setMicrophoneEnabled(false);
        } catch {
          /* ignore */
        }
        return;
      }
      try {
        if (!micTrackRef.current) {
          const track = await createLocalAudioTrack();
          if (cancelled || mutedByTeacher) {
            track.stop();
            return;
          }
          await localParticipant.publishTrack(track);
          if (cancelled || mutedByTeacher) {
            try {
              await localParticipant.unpublishTrack(track);
            } catch {
              /* ignore */
            }
            track.stop();
            return;
          }
          micTrackRef.current = track;
        }
        if (mutedByTeacher) {
          await localParticipant.setMicrophoneEnabled(false);
          return;
        }
        await localParticipant.setMicrophoneEnabled(true);
      } catch (e) {
        console.warn('mic', e);
      }
    }
    syncMic();
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
  const [tab, setTab] = useState<'video' | 'board'>('video');
  const [chatUnread, setChatUnread] = useState(0);
  const [localCamStream, setLocalCamStream] = useState<MediaStream | null>(null);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [wbWriteLocal, setWbWriteLocal] = useState(false);
  const [leftForFullscreen, setLeftForFullscreen] = useState(false);
  const chromeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { state, refresh } = useRoomState(code, 2000);

  const stageMode = state?.stageMode ?? 'idle';
  const whiteboardCanWrite = isTeacher
    ? true
    : !!(state?.whiteboardCanWrite ?? false);
  const teacherIdentities = (state?.admitted ?? [])
    .filter((a) => a.role === 'TEACHER')
    .map((a) => a.livekitIdentity);
  // Fallback: if teacher screen track(s) exist, treat as screen present even if redis idle
  const hasTeacherScreen = useHasTeacherScreen(teacherIdentities);
  const effectiveStage =
    stageMode !== 'idle' ? stageMode : hasTeacherScreen ? 'screen' : 'idle';

  // Keep teacher tab in sync with Redis stage so whiteboard fill layout shows on reload
  useEffect(() => {
    if (!isTeacher) return;
    if (stageMode === 'whiteboard') setTab('board');
    else if (stageMode === 'screen' || stageMode === 'idle') setTab((prev) => (prev === 'board' ? 'video' : prev));
  }, [isTeacher, stageMode]);

  useEffect(() => {
    onVisibilityChange(!!state?.me?.canPublishVideo);
  }, [state?.me?.canPublishVideo, onVisibilityChange]);

  // Sync teacher draw-permission toggle from Redis flag
  useEffect(() => {
    if (isTeacher && typeof state?.whiteboardWriteAllowed === 'boolean') {
      setWbWriteLocal(!!state.whiteboardWriteAllowed);
    }
  }, [isTeacher, state?.whiteboardWriteAllowed]);

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

    const onSpeakers = (speakers: Participant[]) => {
      const visiblesSet = new Set(state?.visibleIdentities ?? visibleIdentities);
      const students = new Set(
        (state?.admitted ?? [])
          .filter((a) => a.role === 'STUDENT')
          .map((a) => a.livekitIdentity)
      );

      for (const s of speakers) {
        if (s.isLocal) continue;
        if (!students.has(s.identity)) continue;
        if (visiblesSet.has(s.identity)) continue;
        const last = pinnedRecently.get(s.identity) || 0;
        if (Date.now() - last < 2000) continue;
        pinnedRecently.set(s.identity, Date.now());
        void roomFetch(code, '/sample/pin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identity: s.identity }),
        }).then((res) => {
          if (res.ok) refresh();
        });
      }
    };

    room.on(RoomEvent.ActiveSpeakersChanged, onSpeakers);
    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, onSpeakers);
    };
  }, [isTeacher, room, code, refresh, state?.admitted, state?.visibleIdentities, visibleIdentities]);

  const postStage = useCallback(
    async (mode: 'idle' | 'screen' | 'whiteboard') => {
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

  const setWbWriteAllowed = useCallback(
    async (allowed: boolean) => {
      if (!isTeacher) return;
      try {
        setWbWriteLocal(allowed);
        await roomFetch(code, '/whiteboard/write', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allowed }),
        });
        refresh();
      } catch (e) {
        console.warn('wb write', e);
      }
    },
    [code, isTeacher, refresh]
  );

  const bumpChrome = useCallback(() => {
    setChromeVisible(true);
    if (chromeTimer.current) clearTimeout(chromeTimer.current);
    // Keep student controls visible — tap still refreshes visibility if ever hidden.
  }, []);

  useEffect(() => {
    if (isTeacher) {
      if (chromeTimer.current) clearTimeout(chromeTimer.current);
      return;
    }
    setChromeVisible(true);
    return () => {
      if (chromeTimer.current) clearTimeout(chromeTimer.current);
    };
  }, [isTeacher]);

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

  const stopScreenShare = useCallback(async () => {
    if (!localParticipant) return;
    try {
      await localParticipant.setScreenShareEnabled(false);
    } catch {
      /* ignore */
    }
    setScreenOn(false);
  }, [localParticipant]);

  const toggleScreen = useCallback(async () => {
    if (!localParticipant || !isTeacher) return;
    try {
      if (screenOn) {
        await localParticipant.setScreenShareEnabled(false);
        setScreenOn(false);
        await postStage('idle');
      } else {
        // Always announce screen stage after successful share start (even if UI state was stale)
        await localParticipant.setScreenShareEnabled(true);
        setScreenOn(true);
        await postStage('screen');
      }
    } catch (e) {
      console.warn('screen share', e);
    }
  }, [localParticipant, screenOn, isTeacher, postStage]);

  const selectTab = useCallback(
    async (next: 'video' | 'board') => {
      setTab(next);
      if (!isTeacher) return;
      if (next === 'board') {
        await stopScreenShare();
        await postStage('whiteboard');
      } else {
        // Video tab: keep screen stage if still sharing, else idle
        if (screenOn) {
          await postStage('screen');
        } else {
          await postStage('idle');
        }
      }
    },
    [isTeacher, stopScreenShare, postStage, screenOn]
  );

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

  const handRaised = !!(state?.me?.handRaised ?? (state?.raisedHands ?? []).includes(state?.me?.id || ''));

  async function toggleHand() {
    if (isTeacher) return;
    const next = !handRaised;
    try {
      await roomFetch(code, '/hand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raised: next }),
      });
      refresh();
    } catch (e) {
      console.warn('hand', e);
    }
  }

  const studentCount = state?.admitted?.filter((a) => a.role === 'STUDENT').length ?? 0;
  const waitingCount = state?.waiting?.length ?? 0;
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
    const badge =
      effectiveStage === 'screen'
        ? 'Teacher screen'
        : effectiveStage === 'whiteboard'
          ? whiteboardCanWrite
            ? 'Whiteboard · drawing allowed'
            : 'Whiteboard · view only'
          : 'Waiting for teacher…';

    return (
      <div
        className="stage-fullscreen"
        onPointerDown={bumpChrome}
        onTouchStart={bumpChrome}
      >
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
            <TeacherScreenStage teacherIdentities={teacherIdentities} />
          ) : effectiveStage === 'whiteboard' ? (
            <div className="stage-fill-middle">
              <Whiteboard
                code={code}
                onEnded={onClassEnded}
                canWrite={whiteboardCanWrite}
                isTeacher={false}
              />
            </div>
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-ink-950 text-slate-400">
              <IconVideo size={32} />
              <p className="text-sm">Waiting for teacher…</p>
            </div>
          )}
        </div>

        <TeacherCameraFloat teacherIdentities={teacherIdentities} roomCode={code} />

        <div
          className={cn(
            'stage-float-chrome',
            chromeVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
          )}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Controls
            {...controlsProps}
            variant="float"
            onToggleChat={() => {
              setChatOpen((v) => !v);
              bumpChrome();
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
          <Chat
            code={code}
            isTeacher={false}
            myParticipantId={state?.me?.id ?? null}
            students={(state?.admitted ?? [])
              .filter((a) => a.role === 'STUDENT')
              .map((a) => ({ id: a.id, displayName: a.displayName }))}
            active={chatOpen}
            onUnreadChange={setChatUnread}
            stopped={state?.status === 'ENDED' || !!state?.ended}
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
            {isTeacher && stageMode !== 'idle' && (
              <Badge tone="neutral">
                Stage · {stageMode === 'screen' ? 'Screen' : 'Whiteboard'}
              </Badge>
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
                {visibles.length}/{Math.min(state?.maxVisibleVideos ?? 6, 6)} in sample
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
          {/* Students must NOT have Video/Whiteboard tabs — only teacher switches stage */}
          {isTeacher && (
            <>
              <div className="flex rounded-xl bg-black/30 p-1">
                <button
                  type="button"
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition',
                    tab === 'video' ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-slate-200'
                  )}
                  onClick={() => void selectTab('video')}
                >
                  <IconVideo size={14} />
                  <span className="hidden sm:inline">Video</span>
                </button>
                <button
                  type="button"
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition',
                    tab === 'board' ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-slate-200'
                  )}
                  onClick={() => void selectTab('board')}
                >
                  <IconBoard size={14} />
                  <span className="hidden sm:inline">Whiteboard</span>
                </button>
              </div>
              {tab === 'board' && (
                <Button
                  variant={wbWriteLocal ? 'warning' : 'secondary'}
                  size="sm"
                  onClick={() => void setWbWriteAllowed(!wbWriteLocal)}
                >
                  {wbWriteLocal ? 'Lock drawing' : 'Allow students to draw'}
                </Button>
              )}
            </>
          )}
        </div>
      </header>

      {/* Main stage — whiteboard/screen fill the entire middle */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {tab === 'board' ? (
          <section className="stage-fill-middle">
            <Whiteboard
              code={code}
              onEnded={onClassEnded}
              canWrite={true}
              isTeacher={true}
            />
          </section>
        ) : (
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
        )}


        <FloatingPanel
          title="Roster"
          storageKey={`teacher_roster_${code.toUpperCase()}`}
          open={rosterOpen}
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
                              onClick={async () => {
                                try {
                                  const res = await roomFetch(code, '/hand', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ participantId: p.id, raised: false }),
                                  });
                                  if (!res.ok) {
                                    const data = await res.json().catch(() => ({}));
                                    console.error('Lower hand failed', res.status, data);
                                    alert(
                                      (data as { error?: string }).error ||
                                        `Could not lower hand (${res.status})`
                                    );
                                    return;
                                  }
                                  refresh();
                                } catch (e) {
                                  console.error('Lower hand error', e);
                                  alert('Could not lower hand');
                                }
                              }}
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
          open={chatOpen}
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
          <Chat
            code={code}
            isTeacher={true}
            myParticipantId={state?.me?.id ?? null}
            students={(state?.admitted ?? [])
              .filter((a) => a.role === 'STUDENT')
              .map((a) => ({ id: a.id, displayName: a.displayName }))}
            active={chatOpen}
            onUnreadChange={setChatUnread}
            stopped={state?.status === 'ENDED' || !!state?.ended}
          />
        </FloatingPanel>
      </div>

      {(stageMode === 'screen' ||
        stageMode === 'whiteboard' ||
        effectiveStage === 'screen' ||
        effectiveStage === 'whiteboard') && (
        <TeacherPeersFloat
          roomCode={code}
          teacherIdentities={teacherIdentities}
          visibleIdentities={visibles}
        />
      )}

      {/* Bottom dock — never covers content */}
      <footer className="shrink-0 border-t border-white/[0.06] bg-surface-1/90 px-3 py-2.5 backdrop-blur-xl sm:px-4">
        <Controls
          {...controlsProps}
          onEnd={endClass}
          onRotateSample={rotateSample}
          onMuteAll={() => muteAllStudents(true)}
          onUnmuteAll={() => muteAllStudents(false)}
          onToggleChat={() => {
            setChatOpen((v) => {
              const next = !v;
              if (next) setChatUnread(0);
              return next;
            });
          }}
          chatOpen={chatOpen}
          chatUnread={chatUnread}
          onToggleRoster={() => setRosterOpen((v) => !v)}
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

    const asStudent =
      !!state.actingAsStudent ||
      state.me?.role === 'STUDENT' ||
      (!state.isTeacher && !!state.me);
    if (asStudent) rememberClassroomRole(code, 'student');
    else if (state.isTeacher) rememberClassroomRole(code, 'teacher');

    setIsTeacher(!!state.isTeacher && !asStudent);
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

  // Poll room status for mute visibility + end-class kick (students especially)
  useEffect(() => {
    if (classEnded) return;
    const t = setInterval(async () => {
      try {
        const stateRes = await roomFetch(code, '/state');
        const state = await stateRes.json();
        if (
          stateRes.status === 410 ||
          state.status === 'ENDED' ||
          state.ended ||
          (state.public && state.status === 'ENDED')
        ) {
          setClassEnded(true);
          setTokenData(null);
          return;
        }
        if (!stateRes.ok) return;
        setCanPublishVideo(!!state.me?.canPublishVideo);
        const asStudent =
          !!state.actingAsStudent ||
          state.me?.role === 'STUDENT' ||
          (!state.isTeacher && !!state.me);
        if (asStudent) {
          rememberClassroomRole(code, 'student');
          setIsTeacher(false);
        } else if (typeof state.isTeacher === 'boolean') {
          setIsTeacher(!!state.isTeacher);
        }
      } catch {
        /* ignore */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [code, classEnded]);

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

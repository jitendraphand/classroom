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
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Tabs } from '@/components/ui/Tabs';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageLoading } from '@/components/ui/Skeleton';
import { IconBoard, IconHand, IconScreen, IconSidebar, IconUsers, IconVideo } from '@/components/ui/Icons';
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
            'stage-primary grid min-h-[38vh] flex-1 gap-3',
            screenShares.length > 1 ? 'lg:grid-cols-2' : 'grid-cols-1'
          )}
        >
          {screenShares.map((t) => (
            <div
              key={`${t.participant.identity}-${t.source}`}
              className="video-tile relative min-h-[220px] w-full overflow-hidden bg-black"
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

function clampFloatPos(x: number, y: number, w: number, h: number): FloatPos {
  const margin = 8;
  const chromeBottom = 96; // keep above student control chrome
  const maxX = Math.max(margin, window.innerWidth - w - margin);
  const maxY = Math.max(margin, window.innerHeight - h - chromeBottom);
  return {
    x: Math.min(maxX, Math.max(margin, x)),
    y: Math.min(maxY, Math.max(margin, y)),
  };
}

function useDraggableFloat(
  storageKey: string,
  defaultPos: () => FloatPos,
  sizeRef: RefObject<{ w: number; h: number }>
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
          setPos(clampFloatPos(parsed.x, parsed.y, sz.w, sz.h));
          return;
        }
      }
    } catch {
      /* ignore */
    }
    setPos(defaultPos());
  }, [storageKey]);

  useEffect(() => {
    const onResize = () => {
      setPos((prev) => {
        if (!prev) return prev;
        const sz = sizeRef.current || { w: 186, h: 105 };
        return clampFloatPos(prev.x, prev.y, sz.w, sz.h);
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [sizeRef]);

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
      const next = clampFloatPos(origin.current.x + dx, origin.current.y + dy, sz.w, sz.h);
      setPos(next);
    },
    [sizeRef]
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
    dragHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
  };
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

function StudentPeersFloat({
  roomCode,
  teacherIdentities,
  visibleIdentities,
  localIdentity,
}: {
  roomCode: string;
  teacherIdentities: string[];
  visibleIdentities: string[];
  localIdentity?: string | null;
}) {
  const room = useRoomContext();
  const teacherSet = new Set(teacherIdentities);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const sizeRef = useRef({ w: 280, h: 220 });
  const [slotCount, setSlotCount] = useState<2 | 4 | 6>(() => {
    try {
      const v = sessionStorage.getItem(`peers_slots_${roomCode.toUpperCase()}`);
      if (v === '2' || v === '4' || v === '6') return Number(v) as 2 | 4 | 6;
    } catch {
      /* ignore */
    }
    return 4;
  });
  const [rotationTick, setRotationTick] = useState(0);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const defaultPos = useCallback((): FloatPos => {
    const w = sizeRef.current.w;
    const h = sizeRef.current.h;
    return clampFloatPos(12, window.innerHeight - h - 100, w, h);
  }, []);

  const { pos, dragHandlers } = useDraggableFloat(
    `peers_float_pos_${roomCode.toUpperCase()}`,
    defaultPos,
    sizeRef
  );

  useEffect(() => {
    try {
      sessionStorage.setItem(`peers_slots_${roomCode.toUpperCase()}`, String(slotCount));
    } catch {
      /* ignore */
    }
  }, [slotCount, roomCode]);

  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const sync = () => {
      sizeRef.current = { w: el.offsetWidth || 280, h: el.offsetHeight || 220 };
    };
    sync();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [slotCount]);

  // Rotate fill slots ~8s to match server sample cadence
  useEffect(() => {
    const iv = window.setInterval(() => setRotationTick((n) => n + 1), 8000);
    return () => window.clearInterval(iv);
  }, []);

  useEffect(() => {
    if (!room) return;
    const onSpeakers = (speakers: Participant[]) => {
      const studentSpeaker = speakers.find(
        (s) =>
          !s.isLocal &&
          !isTeacherParticipant(s, teacherSet) &&
          (!localIdentity || s.identity !== localIdentity)
      );
      setSpeakingId(studentSpeaker?.identity ?? null);
    };
    room.on(RoomEvent.ActiveSpeakersChanged, onSpeakers);
    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, onSpeakers);
    };
  }, [room, teacherIdentities, localIdentity]);

  // Ensure peer cameras in sample are subscribed
  useEffect(() => {
    if (!room) return;
    const ensure = () => {
      for (const p of Array.from(room.remoteParticipants.values())) {
        if (isTeacherParticipant(p, teacherSet)) continue;
        if (localIdentity && p.identity === localIdentity) continue;
        const pub = p.getTrackPublication(Track.Source.Camera);
        if (pub && !pub.isSubscribed) {
          try {
            pub.setSubscribed(true);
          } catch (e) {
            console.warn('subscribe peer cam', e);
          }
        }
      }
      setTick((n) => n + 1);
    };
    ensure();
    room.on(RoomEvent.TrackPublished, ensure);
    room.on(RoomEvent.TrackSubscribed, ensure);
    room.on(RoomEvent.ParticipantConnected, ensure);
    room.on(RoomEvent.ParticipantDisconnected, ensure);
    const iv = window.setInterval(ensure, 2000);
    return () => {
      room.off(RoomEvent.TrackPublished, ensure);
      room.off(RoomEvent.TrackSubscribed, ensure);
      room.off(RoomEvent.ParticipantConnected, ensure);
      room.off(RoomEvent.ParticipantDisconnected, ensure);
      window.clearInterval(iv);
    };
  }, [room, teacherIdentities, localIdentity, visibleIdentities]);

  void tick;
  void rotationTick;

  const peerIds = useMemo(() => {
    const tSet = new Set(teacherIdentities);
    const fromSample = visibleIdentities.filter(
      (id) => id !== localIdentity && !tSet.has(id) && !id.startsWith('teacher_')
    );
    const remote: string[] = [];
    if (room) {
      for (const p of Array.from(room.remoteParticipants.values())) {
        if (isTeacherParticipant(p, tSet)) continue;
        if (localIdentity && p.identity === localIdentity) continue;
        if (!remote.includes(p.identity)) remote.push(p.identity);
      }
    }
    const pool = fromSample.length ? fromSample : remote;
    const slots: string[] = [];
    if (speakingId && (pool.includes(speakingId) || remote.includes(speakingId))) {
      slots.push(speakingId);
    }
    const rest = pool.filter((id) => !slots.includes(id));
    const offset = rotationTick % Math.max(1, rest.length);
    const rotated = rest.length ? [...rest.slice(offset), ...rest.slice(0, offset)] : [];
    for (const id of rotated) {
      if (slots.length >= slotCount) break;
      slots.push(id);
    }
    if (slots.length < slotCount) {
      for (const id of remote) {
        if (slots.length >= slotCount) break;
        if (!slots.includes(id)) slots.push(id);
      }
    }
    return slots.slice(0, slotCount);
  }, [
    visibleIdentities,
    localIdentity,
    teacherIdentities,
    room,
    speakingId,
    rotationTick,
    slotCount,
    tick,
  ]);

  const cols = slotCount === 2 ? 1 : 2;
  const style = pos ? { left: pos.x, top: pos.y } : { left: 12, bottom: 88 };

  return (
    <div
      ref={paneRef}
      className="peers-float-pane"
      style={style}
      aria-label="Classmates — drag to move"
      {...dragHandlers}
    >
      <div className="peers-float-header">
        <span className="text-2xs font-semibold text-slate-200">Classmates</span>
        <div className="flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
          {([2, 4, 6] as const).map((n) => (
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
        </div>
      </div>
      <div
        className="peers-float-grid"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {peerIds.length === 0 && (
          <div className="col-span-full flex aspect-video items-center justify-center rounded-lg bg-black/40 text-2xs text-slate-400">
            No classmates yet
          </div>
        )}
        {peerIds.map((identity) => {
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
              pinned={speakingId === identity}
            />
          );
        })}
      </div>
    </div>
  );
}

function PeerCamTile({
  name,
  mediaTrack,
  speaking,
  pinned,
}: {
  name: string;
  mediaTrack: MediaStreamTrack | null;
  speaking: boolean;
  pinned: boolean;
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
        'relative aspect-video overflow-hidden rounded-lg bg-black',
        speaking && 'ring-2 ring-brand-400'
      )}
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
  const [sideTab, setSideTab] = useState<'roster' | 'chat'>(isTeacher ? 'roster' : 'chat');
  const [chatUnread, setChatUnread] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [localCamStream, setLocalCamStream] = useState<MediaStream | null>(null);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [chatDrawerOpen, setChatDrawerOpen] = useState(false);
  const [wbWriteLocal, setWbWriteLocal] = useState(false);
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
  useEffect(() => {
    if (!isTeacher) setSideTab('chat');
  }, [isTeacher]);

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
      setChatDrawerOpen(false);
      return;
    }
    setChromeVisible(true);
    return () => {
      if (chromeTimer.current) clearTimeout(chromeTimer.current);
    };
  }, [isTeacher]);

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
            <div className="h-full w-full p-0">
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

        {(effectiveStage === 'screen' || effectiveStage === 'whiteboard') && (
          <StudentPeersFloat
            roomCode={code}
            teacherIdentities={teacherIdentities}
            visibleIdentities={visibles}
            localIdentity={state?.me?.livekitIdentity}
          />
        )}

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
            onOpenChat={() => {
              setChatDrawerOpen(true);
              bumpChrome();
            }}
            chatUnread={chatUnread}
          />
        </div>

        {chatDrawerOpen && (
          <>
            <button
              type="button"
              className="absolute inset-0 z-40 bg-black/40"
              aria-label="Close chat"
              onClick={() => setChatDrawerOpen(false)}
            />
            <aside className="stage-chat-drawer">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold">Chat</h2>
                <button
                  type="button"
                  className="text-xs text-slate-400 hover:text-white"
                  onClick={() => setChatDrawerOpen(false)}
                >
                  Close
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <Chat
                  code={code}
                  isTeacher={false}
                  myParticipantId={state?.me?.id ?? null}
                  students={(state?.admitted ?? [])
                    .filter((a) => a.role === 'STUDENT')
                    .map((a) => ({ id: a.id, displayName: a.displayName }))}
                  active={chatDrawerOpen}
                  onUnreadChange={setChatUnread}
                  stopped={state?.status === 'ENDED' || !!state?.ended}
                />
              </div>
            </aside>
          </>
        )}
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
                {visibles.length}/{state?.maxVisibleVideos ?? '—'} in sample
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
          <Button
            variant="secondary"
            size="sm"
            className="!px-2.5 xl:hidden"
            onClick={() => setSidebarOpen((v) => !v)}
            aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          >
            <IconSidebar size={16} />
          </Button>
        </div>
      </header>

      {/* Main + sidebar */}
      <div className="relative grid min-h-0 flex-1 gap-0 overflow-hidden xl:grid-cols-[minmax(0,1fr)_300px]">
        <section className="min-h-0 overflow-y-auto p-3 sm:p-4">
          {/* Students idle: teacher camera/empty only — never mount Whiteboard */}
          {isTeacher && tab === 'board' ? (
            <div className="h-[calc(100dvh-11rem)] min-h-[280px]">
              <Whiteboard
                code={code}
                onEnded={onClassEnded}
                canWrite={true}
                isTeacher={true}
              />
            </div>
          ) : (
            <div className="flex min-h-0 flex-col gap-3 pb-2">
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
          )}
        </section>

        {/* Sidebar — collapsible under xl */}
        <aside
          className={cn(
            'glass z-20 flex max-h-full min-h-0 flex-col overflow-hidden border-l border-white/[0.06] p-3 sm:p-4',
            'xl:relative xl:translate-x-0 xl:opacity-100',
            sidebarOpen
              ? 'absolute inset-y-0 right-0 w-[min(100%,300px)] translate-x-0 shadow-lift'
              : 'absolute inset-y-0 right-0 w-[min(100%,300px)] translate-x-full opacity-0 pointer-events-none xl:pointer-events-auto'
          )}
        >
          <Tabs
            className="mb-3 shrink-0"
            value={sideTab}
            onChange={(id) => {
              setSideTab(id);
              if (id === 'chat') setChatUnread(0);
            }}
            items={
              isTeacher
                ? [
                    { id: 'roster' as const, label: 'Roster' },
                    {
                      id: 'chat' as const,
                      label: 'Chat',
                      badge:
                        chatUnread > 0 && sideTab !== 'chat'
                          ? chatUnread > 9
                            ? '9+'
                            : chatUnread
                          : undefined,
                    },
                  ]
                : [
                    {
                      id: 'chat' as const,
                      label: 'Chat',
                      badge:
                        chatUnread > 0 && sideTab !== 'chat'
                          ? chatUnread > 9
                            ? '9+'
                            : chatUnread
                          : undefined,
                    },
                  ]
            }
          />

          <div
            className={cn(
              'min-h-0 flex-1 flex-col overflow-hidden',
              sideTab === 'chat' ? 'flex' : 'hidden'
            )}
          >
            <Chat
              code={code}
              isTeacher={isTeacher}
              myParticipantId={state?.me?.id ?? null}
              students={(state?.admitted ?? [])
                .filter((a) => a.role === 'STUDENT')
                .map((a) => ({ id: a.id, displayName: a.displayName }))}
              active={sideTab === 'chat'}
              onUnreadChange={setChatUnread}
              stopped={state?.status === 'ENDED' || !!state?.ended}
            />
          </div>

          {isTeacher && sideTab === 'roster' && (
            <div className="flex min-h-0 flex-1 flex-col space-y-3 overflow-hidden">
              {isTeacher && (
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button size="sm" variant="warning" onClick={() => muteAllStudents(true)}>
                    Mute all
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => muteAllStudents(false)}>
                    Unmute all
                  </Button>
                </div>
              )}
              <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto text-sm">
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
                    const ah = a.role === 'STUDENT' && (a.handRaised || (state?.raisedHands ?? []).includes(a.id)) ? 1 : 0;
                    const bh = b.role === 'STUDENT' && (b.handRaised || (state?.raisedHands ?? []).includes(b.id)) ? 1 : 0;
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
                              <span className="inline-flex shrink-0 text-amber-300" title="Hand raised" aria-label="Hand raised">
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
                    {isTeacher && p.role === 'STUDENT' && (
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
                              await roomFetch(code, '/hand', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ participantId: p.id, raised: false }),
                              });
                              refresh();
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
              {isTeacher && waitingCount > 0 && (
                <div className="shrink-0 border-t border-white/5 pt-3">
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
          )}
        </aside>
      </div>

      {/* Bottom dock — never covers content */}
      <footer className="shrink-0 border-t border-white/[0.06] bg-surface-1/90 px-3 py-2.5 backdrop-blur-xl sm:px-4">
        <Controls
          {...controlsProps}
          onEnd={endClass}
          onRotateSample={rotateSample}
          onMuteAll={() => muteAllStudents(true)}
          onUnmuteAll={() => muteAllStudents(false)}
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

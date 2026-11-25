'use client';

import { LiveKitRoom, RoomAudioRenderer, StartAudio, useRoomContext, VideoTrack } from '@livekit/components-react';
import { RoomEvent, Track, VideoQuality, type RemoteParticipant, type RemoteTrackPublication, type Room } from 'livekit-client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { EndClassDialog, requestAdminEndClass } from '@/components/admin/EndClassDialog';
import { Button } from '@/components/ui/Button';
import { useNow } from '@/components/admin/OngoingClasses';
import { isTeacherParticipant } from '@/components/classroom/participantRoles';
import { StudentViewStage } from '@/components/classroom/StudentViewStage';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { IconMic, IconSpeaker, IconSpeakerOff, IconVideo } from '@/components/ui/Icons';
import { useSessionEnded } from '@/hooks/useSessionEnded';
import { api } from '@/lib/clientFetch';
import {
  formatElapsed,
  OBSERVER_HEARTBEAT_MS,
  OBSERVER_HIDDEN_DISCONNECT_MS,
  type LiveClass,
} from '@/lib/liveClassesLogic';
import { formatTime } from '@/lib/timeFormat';

type Student = {
  id: string;
  identity?: string;
  name: string;
  gradeDivision: string;
  rollNumber: string | null;
  camOn?: boolean;
};

const ROOM_OPTIONS = { adaptiveStream: true, dynacast: false, disconnectOnPageLeave: true } as const;
const CONNECT_OPTIONS = { autoSubscribe: false, peerConnectionTimeout: 20_000 } as const;
const NO_TEACHERS = new Set<string>();

/** Notify the server that this observer left so students stop publishing extra observer cameras. */
function releaseObserver(code: string, identity: string) {
  if (!identity) return;
  void fetch(`/api/admin/live/${encodeURIComponent(code)}/observer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity, active: false }),
    keepalive: true,
    credentials: 'same-origin',
  }).catch(() => undefined);
}

/**
 * Admin sitting in a live class as a hidden, listen-only observer:
 * - Nothing streams until this page opens.
 * - Top: read-only, fit-to-area student stage (whiteboard / screen share / teacher camera) with NO zoom controls.
 * - Bottom: grid of ALL connected students (low-layer video when camera is on, blank initials tile when off).
 * - Audio toggle (default OFF): hears teacher + unmuted students when ON, never publishes anything.
 */
export default function AdminObservePage() {
  const params = useParams<{ code: string }>();
  const code = String(params?.code || '').toUpperCase();
  return (
    <AdminShell title="Observing class">
      <Observer code={code} />
    </AdminShell>
  );
}

function Observer({ code }: { code: string }) {
  const [info, setInfo] = useState<{ class: LiveClass; students: Student[] } | null>(null);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState('');
  const [conn, setConn] = useState<{ token: string; serverUrl: string; identity: string } | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [hiddenPaused, setHiddenPaused] = useState(false);
  const [endAsk, setEndAsk] = useState(false);
  const [endingClass, setEndingClass] = useState(false);
  const [endedByAdmin, setEndedByAdmin] = useState(false);
  const [search, setSearch] = useState('');
  const [camerasOnly, setCamerasOnly] = useState(false);
  const now = useNow();
  // Admin signed in elsewhere: leave the class (LiveKitRoom unmounts = disconnect).
  const sessionEnded = useSessionEnded();
  const [stopped, setStopped] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const connIdentityRef = useRef<string>('');
  const releasedRef = useRef<Set<string>>(new Set());

  const releaseOnce = useCallback(
    (identity: string) => {
      if (!identity || releasedRef.current.has(identity)) return;
      releasedRef.current.add(identity);
      releaseObserver(code, identity);
    },
    [code]
  );

  const load = useCallback(async () => {
    const { ok, status, data } = await api<{ class: LiveClass; students: Student[] }>(
      `/api/admin/live/${encodeURIComponent(code)}`
    );
    if (ok) {
      setInfo({ class: data.class, students: data.students });
      setError('');
    } else if (status === 404) {
      setEnded(true);
      setConn(null);
    } else if (status === 401) {
      // Signed out / replaced: stop polling; StaffSessionGuard explains why.
      setStopped(true);
      setConn(null);
    } else setError(data.error || 'Could not load the class');
  }, [code]);

  useEffect(() => {
    if (sessionEnded || stopped) return;
    void load();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 5_000);
    return () => clearInterval(id);
  }, [load, sessionEnded, stopped]);

  // Disconnect media if the browser tab stays hidden for long, and reconnect on return.
  useEffect(() => {
    let timer: number | null = null;
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        if (timer !== null) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          setHiddenPaused(true);
          if (connIdentityRef.current) {
            releaseOnce(connIdentityRef.current);
            connIdentityRef.current = '';
          }
          setConn(null);
        }, OBSERVER_HIDDEN_DISCONNECT_MS);
      } else {
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
        setHiddenPaused(false);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [releaseOnce]);

  // Obtain an observer token when active and visible; release lease on leave/switch/close.
  useEffect(() => {
    if (sessionEnded || stopped || ended || hiddenPaused) return;
    let cancelled = false;
    void api<{ token: string; serverUrl: string; identity: string }>(
      `/api/admin/live/${encodeURIComponent(code)}/token`,
      { body: { mode: 'observe' } }
    ).then(({ ok, status, data }) => {
      if (cancelled) {
        if (ok && data?.identity) releaseOnce(data.identity);
        return;
      }
      if (ok) {
        connIdentityRef.current = data.identity;
        releasedRef.current.delete(data.identity);
        setConn({ token: data.token, serverUrl: data.serverUrl, identity: data.identity });
      } else if (status === 404) setEnded(true);
      else if (status === 401) setStopped(true);
      else setError(data.error || 'Could not join the class');
    });
    return () => {
      cancelled = true;
      if (connIdentityRef.current) {
        releaseOnce(connIdentityRef.current);
        connIdentityRef.current = '';
      }
    };
  }, [code, sessionEnded, stopped, ended, hiddenPaused, releaseOnce]);

  // Heartbeat the active observer lease while connected, and release on pagehide/beforeunload.
  useEffect(() => {
    const id = conn?.identity;
    if (!id || sessionEnded || stopped || ended) return;
    const beat = () => {
      if (document.visibilityState !== 'visible') return;
      void api(`/api/admin/live/${encodeURIComponent(code)}/observer`, {
        body: { identity: id, active: true },
      }).catch(() => undefined);
    };
    const iv = window.setInterval(beat, OBSERVER_HEARTBEAT_MS);
    const onUnload = () => releaseOnce(id);
    window.addEventListener('pagehide', onUnload);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener('pagehide', onUnload);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [code, conn?.identity, sessionEnded, stopped, ended, releaseOnce]);

  const toggleAudio = () => {
    setAudioEnabled((prev) => {
      const next = !prev;
      if (next) void roomRef.current?.startAudio().catch(() => undefined);
      return next;
    });
  };

  const handleLeave = () => {
    if (connIdentityRef.current) {
      releaseOnce(connIdentityRef.current);
      connIdentityRef.current = '';
    }
    try {
      void roomRef.current?.disconnect();
    } catch {
      /* ignore */
    }
  };

  const confirmEndClass = async () => {
    if (endingClass) return;
    setEndingClass(true);
    const res = await requestAdminEndClass(code);
    if (!res.ok) {
      setEndingClass(false);
      setEndAsk(false);
      setError(res.error || 'Could not end the class. Everyone is still in the room.');
      return;
    }
    handleLeave();
    setEndedByAdmin(true);
    setEnded(true);
    setConn(null);
    setEndAsk(false);
    setEndingClass(false);
  };

  if (ended) {
    return (
      <Card>
        <p className="text-sm text-slate-300">
          {endedByAdmin
            ? 'You ended this class for everyone. Attendance is saved.'
            : 'This class is not live (it may have just ended).'}
        </p>
        <Link href="/admin/live" className="btn-secondary mt-4 inline-flex px-3 py-1.5 text-sm">
          Back to ongoing classes
        </Link>
      </Card>
    );
  }

  const c = info?.class;
  const activeMedia = !!(conn && !sessionEnded && !stopped && !hiddenPaused);
  const camOnCount = info?.students.filter((s) => s.camOn).length ?? 0;
  const query = search.trim().toLowerCase();

  const mainStage = (
    <div className="relative aspect-video max-h-[64vh] w-full overflow-hidden rounded-2xl border border-white/10 bg-ink-950">
      {activeMedia ? (
        <StudentViewStage code={code} mode="observe" audioEnabled={audioEnabled} disableZoom />
      ) : (
        <div className="flex h-full items-center justify-center text-sm text-slate-400">
          {sessionEnded || stopped
            ? 'Viewer stopped: you were signed out.'
            : hiddenPaused
              ? 'Stream paused while tab was hidden — resuming…'
              : 'Connecting to live class…'}
        </div>
      )}
      {c && (
        <div className="pointer-events-none absolute left-3 top-3 rounded-lg bg-black/65 px-2 py-1 font-mono text-xs text-white">
          {formatElapsed(now - new Date(c.startedAt).getTime())}
        </div>
      )}
    </div>
  );

  const studentGridSection = (
    <Card padding={false} className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-sm font-semibold text-white">
            Students in class {info ? `(${info.students.length})` : ''}
          </h2>
          {info && (
            <span className="text-xs text-slate-400">
              · {camOnCount} camera{camOnCount === 1 ? '' : 's'} on
            </span>
          )}
        </div>
        {info && info.students.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Find student…"
              aria-label="Filter students by name"
              className="w-40 rounded-lg border border-white/10 bg-ink-950 px-2.5 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:border-brand-400 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setCamerasOnly((v) => !v)}
              aria-pressed={camerasOnly}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition ${
                camerasOnly
                  ? 'border-brand-400/60 bg-brand-500/20 text-brand-200'
                  : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
              }`}
            >
              <IconVideo size={13} />
              Cameras on only
            </button>
          </div>
        )}
      </div>

      {!info ? (
        <p className="text-xs text-slate-500">Loading students…</p>
      ) : info.students.length === 0 ? (
        <p className="text-xs text-slate-500">No students connected.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
          {info.students.map((s) => {
            const matchesQuery =
              !query || s.name.toLowerCase().includes(query) || s.gradeDivision.toLowerCase().includes(query);
            const matchesCam = !camerasOnly || !!s.camOn;
            const hidden = !matchesQuery || !matchesCam;
            return (
              <li
                key={s.id}
                data-testid="observer-student"
                className={`min-w-0 overflow-hidden rounded-xl border border-white/10 bg-ink-950/90 text-sm text-slate-300 ${
                  hidden ? 'hidden' : ''
                }`}
              >
                {activeMedia ? (
                  <ObserverStudentMedia student={s} />
                ) : (
                  <BlankStudentTile name={s.name} camExpected={!!s.camOn} unmuted={false} />
                )}
                <div className="px-2.5 py-2">
                  <span className="block truncate font-medium text-slate-100" title={s.name}>
                    {s.name}
                  </span>
                  <span className="block truncate text-xs text-slate-400">
                    {s.gradeDivision}
                    {s.rollNumber ? ` · ${s.rollNumber}` : ''}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        You are invisible to the teacher and students and are not counted in attendance. Student cameras stream at low
        resolution while visible on screen.
      </p>
    </Card>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-white">{c?.subject || c?.title || code}</p>
          {c && (
            <p className="text-xs text-slate-400">
              {c.gradeDivision} · {c.teacherName} · started {formatTime(c.startedAt)}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="violet">Observer · hidden · listen-only</Badge>
          <button
            type="button"
            data-testid="observer-audio-toggle"
            aria-pressed={audioEnabled}
            onClick={toggleAudio}
            disabled={!activeMedia}
            className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 ${
              audioEnabled
                ? 'border-emerald-400/50 bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30'
                : 'border-white/15 bg-white/5 text-slate-200 hover:bg-white/10'
            }`}
          >
            {audioEnabled ? <IconSpeaker size={15} /> : <IconSpeakerOff size={15} />}
            {audioEnabled ? 'Audio on' : 'Audio off'}
          </button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            data-testid="admin-end-class"
            onClick={() => setEndAsk(true)}
            disabled={!info || endingClass}
          >
            End class
          </Button>
          <Link href="/admin/live" onClick={handleLeave} className="btn-secondary px-3 py-1.5 text-sm">
            Leave
          </Link>
        </div>
      </div>

      {error && (
        <p className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm text-danger-fg" role="alert">
          {error}
        </p>
      )}

      {activeMedia && conn ? (
        <LiveKitRoom
          token={conn.token}
          serverUrl={conn.serverUrl}
          connect
          audio={false}
          video={false}
          options={ROOM_OPTIONS}
          connectOptions={CONNECT_OPTIONS}
          onConnected={() => undefined}
          onDisconnected={() => {
            roomRef.current = null;
          }}
          className="space-y-4"
        >
          <RoomRefCapture roomRef={roomRef} />
          <ObserverAudioController audioEnabled={audioEnabled} />
          {audioEnabled && (
            <>
              <RoomAudioRenderer />
              <StartAudio
                label="Click to enable class audio"
                className="btn-primary fixed bottom-5 right-5 z-40 px-3.5 py-2 text-sm shadow-lg"
              />
            </>
          )}
          {mainStage}
          {studentGridSection}
        </LiveKitRoom>
      ) : (
        <div className="space-y-4">
          {mainStage}
          {studentGridSection}
        </div>
      )}

      <EndClassDialog
        open={endAsk}
        busy={endingClass}
        classLabel={c ? `${c.subject || c.title} · ${c.teacherName}` : code}
        onConfirm={() => void confirmEndClass()}
        onCancel={() => { setEndAsk(false); setEndingClass(false); }}
      />
    </div>
  );
}

function RoomRefCapture({ roomRef }: { roomRef: React.MutableRefObject<Room | null> }) {
  const room = useRoomContext();
  useEffect(() => {
    roomRef.current = room;
    return () => {
      if (roomRef.current === room) roomRef.current = null;
    };
  }, [room, roomRef]);
  return null;
}

/**
 * Subscribe to unmuted student microphones ONLY when `audioEnabled` is true
 * (teacher audio is managed by StudentViewStage). Never publishes anything.
 */
function ObserverAudioController({ audioEnabled }: { audioEnabled: boolean }) {
  const room = useRoomContext();
  useEffect(() => {
    const sync = () => {
      room.remoteParticipants.forEach((p: RemoteParticipant) => {
        if (isTeacherParticipant(p, NO_TEACHERS)) return;
        p.trackPublications.forEach((pub) => {
          if (pub.source !== Track.Source.Microphone) return;
          const want = audioEnabled && !pub.isMuted;
          if (pub.isDesired !== want || pub.isSubscribed !== want) {
            try {
              pub.setSubscribed(want);
            } catch {
              /* ignore transient permission state */
            }
          }
        });
      });
    };
    sync();
    const events = [
      RoomEvent.Connected,
      RoomEvent.Reconnected,
      RoomEvent.ParticipantConnected,
      RoomEvent.TrackPublished,
      RoomEvent.TrackUnpublished,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.TrackSubscriptionPermissionChanged,
    ] as const;
    events.forEach((e) => room.on(e, sync));
    return () => {
      events.forEach((e) => room.off(e, sync));
    };
  }, [room, audioEnabled]);
  return null;
}

function BlankStudentTile({ name, camExpected, unmuted }: { name: string; camExpected: boolean; unmuted: boolean }) {
  return (
    <div className="relative flex aspect-video w-full flex-col items-center justify-center gap-1.5 bg-ink-900 px-2">
      <Avatar name={name} size="md" />
      <span className="text-[11px] text-slate-500">{camExpected ? 'Connecting video…' : 'Camera off'}</span>
      {unmuted && (
        <span
          className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300"
          title="Unmuted"
        >
          <IconMic size={10} />
        </span>
      )}
    </div>
  );
}

function findStudentParticipant(room: Room, s: Student): RemoteParticipant | undefined {
  if (s.identity) {
    const exact = room.remoteParticipants.get(s.identity);
    if (exact) return exact;
  }
  const prefix = `student_${s.id}`;
  for (const p of room.remoteParticipants.values()) {
    if (p.identity === prefix || p.identity.startsWith(`${prefix}_`)) return p;
    if (p.metadata) {
      try {
        const meta = JSON.parse(p.metadata) as { userId?: string };
        if (meta.userId === s.id) return p;
      } catch {
        /* ignore malformed metadata */
      }
    }
  }
  return undefined;
}

function ObserverStudentMedia({ student }: { student: Student }) {
  const room = useRoomContext();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => setInView(!!entry?.isIntersecting),
      { rootMargin: '250px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const sync = useCallback(() => {
    const p = findStudentParticipant(room, student);
    if (p) {
      p.trackPublications.forEach((pub) => {
        if (pub.source !== Track.Source.Camera) return;
        const want = inView && !pub.isMuted;
        if (pub.isDesired !== want || pub.isSubscribed !== want) {
          try {
            pub.setSubscribed(want);
          } catch {
            /* ignore transient permission state */
          }
        }
        if (want) {
          try {
            pub.setVideoQuality(VideoQuality.LOW);
          } catch {
            /* ignore */
          }
        }
      });
    }
    setTick((n) => n + 1);
  }, [room, student, inView]);

  useEffect(() => {
    sync();
    const events = [
      RoomEvent.Connected,
      RoomEvent.Reconnected,
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.TrackPublished,
      RoomEvent.TrackUnpublished,
      RoomEvent.TrackSubscribed,
      RoomEvent.TrackUnsubscribed,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.TrackSubscriptionPermissionChanged,
    ] as const;
    events.forEach((e) => room.on(e, sync));
    return () => {
      events.forEach((e) => room.off(e, sync));
    };
  }, [room, sync]);

  // Unsubscribe when leaving viewport or unmounting.
  useEffect(() => {
    return () => {
      const p = findStudentParticipant(room, student);
      if (!p) return;
      p.trackPublications.forEach((pub) => {
        if (pub.source === Track.Source.Camera && (pub.isDesired || pub.isSubscribed)) {
          try {
            pub.setSubscribed(false);
          } catch {
            /* ignore */
          }
        }
      });
    };
  }, [room, student]);

  const participant = findStudentParticipant(room, student);
  let camPub: RemoteTrackPublication | undefined;
  let micPub: RemoteTrackPublication | undefined;
  if (participant) {
    participant.trackPublications.forEach((pub) => {
      if (pub.source === Track.Source.Camera) camPub = pub;
      if (pub.source === Track.Source.Microphone) micPub = pub;
    });
  }

  const camLive = !!(participant && camPub && !camPub.isMuted && camPub.isSubscribed && camPub.track);
  const unmuted = !!(micPub && !micPub.isMuted);
  const trackRef = useMemo(
    () => (camLive && participant && camPub ? { participant, publication: camPub, source: camPub.source } : null),
    [camLive, participant, camPub]
  );

  // Retry subscription briefly if camera is expected on but SFU permission arrived late.
  useEffect(() => {
    if (!inView || camLive || !(student.camOn || (camPub && !camPub.isMuted))) return;
    const iv = window.setInterval(sync, 1_500);
    return () => window.clearInterval(iv);
  }, [inView, camLive, student.camOn, camPub, sync]);

  return (
    <div ref={boxRef} className="relative aspect-video w-full overflow-hidden bg-ink-900">
      {trackRef ? (
        <>
          <VideoTrack trackRef={trackRef} className="h-full w-full object-cover" />
          {unmuted && (
            <span
              className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-emerald-500/80 px-1.5 py-0.5 text-[10px] font-medium text-white shadow"
              title="Unmuted"
            >
              <IconMic size={10} />
            </span>
          )}
        </>
      ) : (
        <BlankStudentTile name={student.name} camExpected={!!(student.camOn || (camPub && !camPub.isMuted))} unmuted={unmuted} />
      )}
    </div>
  );
}

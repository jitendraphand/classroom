'use client';

import { LiveKitRoom, RoomAudioRenderer, StartAudio } from '@livekit/components-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { useNow } from '@/components/admin/OngoingClasses';
import { StudentViewStage } from '@/components/classroom/StudentViewStage';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { api } from '@/lib/clientFetch';
import { formatElapsed, type LiveClass } from '@/lib/liveClassesLogic';
import { useSessionEnded } from '@/hooks/useSessionEnded';

type Student = { id: string; name: string; gradeDivision: string; rollNumber: string | null };

const ROOM_OPTIONS = { adaptiveStream: true, dynacast: false, disconnectOnPageLeave: true } as const;
const CONNECT_OPTIONS = { autoSubscribe: false, peerConnectionTimeout: 20_000 } as const;

/**
 * Admin sitting in a live class as a hidden, listen-only observer: sees the
 * student view (teacher share / camera) and hears the teacher; sees the roster
 * of connected students by name, never their video. Nothing is published.
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
  const [conn, setConn] = useState<{ token: string; serverUrl: string } | null>(null);
  const now = useNow();
  // Admin signed in elsewhere: leave the class (LiveKitRoom unmounts = disconnect).
  const sessionEnded = useSessionEnded();

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
    } else setError(data.error || 'Could not load the class');
  }, [code]);

  useEffect(() => {
    void load();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 5_000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void api<{ token: string; serverUrl: string }>(`/api/admin/live/${encodeURIComponent(code)}/token`, {
      body: { mode: 'observe' },
    }).then(({ ok, status, data }) => {
      if (cancelled) return;
      if (ok) setConn({ token: data.token, serverUrl: data.serverUrl });
      else if (status === 404) setEnded(true);
      else setError(data.error || 'Could not join the class');
    });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (ended) {
    return (
      <Card>
        <p className="text-sm text-slate-300">This class is not live (it may have just ended).</p>
        <Link href="/admin/live" className="btn-secondary mt-4 inline-flex px-3 py-1.5 text-sm">
          Back to ongoing classes
        </Link>
      </Card>
    );
  }

  const c = info?.class;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-white">{c?.title ?? code}</p>
          {c && (
            <p className="text-xs text-slate-400">
              {c.gradeDivision} · {c.teacherName} · started{' '}
              {new Date(c.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="violet">Observer · hidden · listen-only</Badge>
          <Link href="/admin/live" className="btn-secondary px-3 py-1.5 text-sm">
            Leave
          </Link>
        </div>
      </div>
      {error && (
        <p className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm text-danger-fg" role="alert">
          {error}
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-ink-950">
          {conn && !sessionEnded ? (
            <LiveKitRoom
              token={conn.token}
              serverUrl={conn.serverUrl}
              connect
              audio={false}
              video={false}
              options={ROOM_OPTIONS}
              connectOptions={CONNECT_OPTIONS}
              className="h-full w-full"
            >
              <StudentViewStage code={code} mode="observe" />
              {/* Only teacher audio is ever subscribed (see StudentViewStage). */}
              <RoomAudioRenderer />
              <StartAudio
                label="Click to hear the class"
                className="btn-primary absolute left-1/2 top-3 -translate-x-1/2 px-3 py-1.5 text-sm"
              />
            </LiveKitRoom>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">Joining…</div>
          )}
          {c && (
            <div className="pointer-events-none absolute left-3 top-3 rounded-lg bg-black/65 px-2 py-1 font-mono text-xs text-white">
              {formatElapsed(now - new Date(c.startedAt).getTime())}
            </div>
          )}
        </div>
        <Card padding={false} className="p-4">
          <p className="mb-2 text-sm font-semibold text-white">
            Students connected {info ? `(${info.students.length})` : ''}
          </p>
          {!info ? (
            <p className="text-xs text-slate-500">Loading…</p>
          ) : info.students.length === 0 ? (
            <p className="text-xs text-slate-500">No students connected.</p>
          ) : (
            <ul className="max-h-[50vh] space-y-1 overflow-y-auto text-sm">
              {info.students.map((s) => (
                <li key={s.id} className="flex justify-between gap-2 text-slate-300">
                  <span className="truncate">{s.name}</span>
                  <span className="shrink-0 text-xs text-slate-500">
                    {s.gradeDivision}
                    {s.rollNumber ? ` · ${s.rollNumber}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
            You are invisible to the teacher and students and are not counted in attendance. Student video is never
            shown here — you see what students see.
          </p>
        </Card>
      </div>
    </div>
  );
}

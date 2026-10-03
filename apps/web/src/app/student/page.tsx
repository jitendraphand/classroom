'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { PageLoading } from '@/components/ui/Skeleton';
import { SchoolAppOnly } from '@/components/join/SchoolAppOnly';
import { rememberClassroomRole } from '@/lib/classroomClient';
import { api } from '@/lib/clientFetch';
import { nextPollDelay } from '@/lib/studentCheck';

type ClassInfo = {
  subject: string;
  audience: string;
  teacherName: string | null;
  date: string;
  start: string | null;
  end: string | null;
};
type Route = {
  student: {
    name: string;
    rollNumber: string | null;
    gradeDivision: string;
    /** Grade/division not in the school's Grades & divisions list (see studentAudienceStatus). */
    audienceStatus?: 'ok' | 'unknown_grade' | 'unknown_division';
  };
  now: string;
  /** Routing fingerprint; /api/student/check returns the same value. */
  sig: string;
} & (
  | { kind: 'room'; waitingUrl: string; cls: ClassInfo }
  | { kind: 'waiting_for_teacher'; cls: ClassInfo }
  | { kind: 'upcoming'; cls: ClassInfo; opensAt: string }
  | { kind: 'ended'; cls: ClassInfo; next: ClassInfo | null }
  | { kind: 'none'; next: ClassInfo | null }
);

function time(iso: string | null) {
  return iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
}
function day(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
}
function countdown(ms: number) {
  if (ms <= 0) return 'now';
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h} h ${m} min`;
  if (m >= 10) return `${m} min`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * Landing page after the school-app link: routes the student to their class's
 * waiting room, a countdown, "class ended" or "no class right now", and moves
 * them on automatically when a class opens (see the auto-check below).
 */
export default function StudentHome() {
  const router = useRouter();
  const [route, setRoute] = useState<Route | null>(null);
  const [unauth, setUnauth] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const skew = useRef(0);
  const redirecting = useRef(false);

  const load = useCallback(async () => {
    const { ok, status, data } = await api<Route>('/api/student/route', { method: 'POST' });
    if (status === 401) {
      setUnauth(true);
      return;
    }
    if (!ok) {
      setError(data.error || 'Could not load your classes.');
      return;
    }
    setError('');
    skew.current = new Date(data.now).getTime() - Date.now();
    setRoute(data);
    if (data.kind === 'room' && !redirecting.current) {
      redirecting.current = true;
      const code = data.waitingUrl.split('/')[2]?.split('?')[0];
      if (code) rememberClassroomRole(code, 'student');
      router.replace(data.waitingUrl);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Auto-check: poll the cheap, read-only GET /api/student/check (10–15 s with
   * jitter; ~4–6 s while checked in and waiting for the teacher; on time for a
   * countdown) and only call the full POST /api/student/route — which checks
   * the student in and moves them to the waiting room — when the routing
   * signature changes. Paused while the tab is hidden; checks at once when it
   * becomes visible again.
   */
  useEffect(() => {
    if (!route || route.kind === 'room') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const delay = () => {
      let ms = route.kind === 'waiting_for_teacher' ? nextPollDelay(5_000, 1_000) : nextPollDelay();
      if (route.kind === 'upcoming') {
        const left = new Date(route.opensAt).getTime() - (Date.now() + skew.current);
        ms = Math.max(1_000, Math.min(ms, left + 500 + Math.random() * 1_500));
      }
      return ms;
    };
    const schedule = () => {
      if (stopped || document.visibilityState !== 'visible') return;
      timer = setTimeout(check, delay());
    };
    async function check() {
      timer = null;
      if (stopped) return;
      const { ok, status, data } = await api<{ sig: string }>('/api/student/check');
      if (stopped) return;
      if (status === 401) {
        setUnauth(true);
        return;
      }
      if (ok && data.sig !== route!.sig) {
        await load(); // a new `route` restarts this effect (and stops this loop)
      }
      schedule();
    }
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') {
        if (timer) clearTimeout(timer);
        timer = null;
      } else if (!timer) {
        void check();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    schedule();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [route, load]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (unauth) return <SchoolAppOnly title="Open your class from the school app" />;
  if (!route) return <PageLoading label={error || 'Finding your class…'} />;

  const s = route.student;
  const header = (
    <div className="mb-5 text-center">
      <p className="text-sm text-slate-400">Hi,</p>
      <h1 className="font-display text-2xl font-semibold tracking-tight">{s.name}</h1>
      <p className="mt-1 text-xs text-slate-500">
        {s.gradeDivision}
        {s.rollNumber ? ` · Roll ${s.rollNumber}` : ''}
      </p>
      {s.audienceStatus && s.audienceStatus !== 'ok' && (
        <div
          className="mt-4 rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-left text-sm text-amber-100"
          role="alert"
        >
          <p className="font-semibold">
            {s.audienceStatus === 'unknown_grade' ? 'Your grade' : 'Your division'} ({s.gradeDivision}) is not set up in
            the classroom yet
          </p>
          <p className="mt-1 text-amber-100/80">
            Classes for your grade and division can&apos;t be found until the school adds it. Please tell your teacher
            or the school office. If the grade or division is wrong, it must be corrected in the school app.
          </p>
        </div>
      )}
    </div>
  );

  const nextLine = (next: ClassInfo | null) =>
    next ? (
      <p className="mt-4 text-sm text-slate-300">
        Next: <strong className="text-white">{next.subject}</strong> · {day(next.start)} at {time(next.start)}
        {next.teacherName ? ` · ${next.teacherName}` : ''}
      </p>
    ) : (
      <p className="mt-4 text-sm text-slate-500">No classes scheduled in the next 7 days.</p>
    );

  let body: React.ReactNode;
  if (route.kind === 'room') {
    body = <p className="text-slate-300">Taking you to the waiting room…</p>;
  } else if (route.kind === 'waiting_for_teacher') {
    body = (
      <>
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-brand-500/15 ring-1 ring-brand-400/30">
          <span className="indicator-pulse scale-150">
            <span />
          </span>
        </div>
        <Badge tone="success">You&apos;re checked in</Badge>
        <h2 className="mt-3 font-display text-xl font-semibold">{route.cls.subject}</h2>
        <p className="mt-1 text-sm text-slate-400">
          {route.cls.audience}
          {route.cls.start ? ` · ${time(route.cls.start)}${route.cls.end ? `–${time(route.cls.end)}` : ''}` : ''}
        </p>
        <p className="mt-4 text-sm text-slate-300">
          Waiting for {route.cls.teacherName || 'your teacher'} to open the class. You&apos;ll go in automatically —
          keep this page open.
        </p>
      </>
    );
  } else if (route.kind === 'upcoming') {
    const left = new Date(route.opensAt).getTime() - (now + skew.current);
    body = (
      <>
        <Badge tone="sky">Next class today</Badge>
        <h2 className="mt-3 font-display text-xl font-semibold">{route.cls.subject}</h2>
        <p className="mt-1 text-sm text-slate-400">
          {time(route.cls.start)}–{time(route.cls.end)}
          {route.cls.teacherName ? ` · ${route.cls.teacherName}` : ''}
        </p>
        <p className="mt-6 text-xs uppercase tracking-wider text-slate-500">Waiting room opens in</p>
        <p className="mt-1 font-display text-4xl font-bold tabular-nums text-brand-300" aria-live="polite">
          {countdown(left)}
        </p>
        <p className="mt-4 text-xs text-slate-500">at {time(route.opensAt)} · this page opens it for you automatically</p>
      </>
    );
  } else if (route.kind === 'ended') {
    body = (
      <>
        <Badge tone="neutral">Class ended</Badge>
        <h2 className="mt-3 font-display text-xl font-semibold">{route.cls.subject}</h2>
        <p className="mt-2 text-sm text-slate-400">Your teacher has ended this class.</p>
        {nextLine(route.next)}
        <p className="mt-6 text-xs text-slate-500">
          Keep this page open: if your teacher starts another class for you, you&apos;ll be taken in automatically.
        </p>
      </>
    );
  } else {
    body = (
      <>
        <h2 className="font-display text-xl font-semibold">No class right now</h2>
        {nextLine(route.next)}
        <p className="mt-6 text-xs text-slate-500">
          Keep this page open: when your class starts you&apos;ll be taken in automatically. You can also close it
          and open your class from the school app later.
        </p>
      </>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10 sm:px-6">
      {header}
      <Card className="text-center">{body}</Card>
      {error && (
        <p className="mt-4 text-center text-sm text-danger-fg" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}

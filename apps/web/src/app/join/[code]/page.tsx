'use client';

import { waitingPollMs } from '@/lib/pollPolicy';
import { usePageHidden } from '@/hooks/usePageHidden';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { BackLink } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { markSchoolStudentTab, rememberClassroomRole } from '@/lib/classroomClient';
import { PageLoading } from '@/components/ui/Skeleton';
import { SchoolAppOnly } from '@/components/join/SchoolAppOnly';
import { lobbyEndedFor } from '@/lib/lobbyState';

type State = {
  code?: string;
  name?: string;
  status?: string;
  teacherName?: string;
  public?: boolean;
  me?: { status: string; displayName: string; role?: string; viaSchoolApp?: boolean };
  manualJoinAllowed?: boolean;
  teacherSessionActive?: boolean;
  teacherSessionName?: string;
  actingAsStudent?: boolean;
  meLeft?: boolean;
  classFull?: boolean;
};

const leftKey = (code: string) => `waiting_left_${code}`;

export default function JoinRoomPage() {
  const params = useParams();
  const search = useSearchParams();
  const router = useRouter();
  const code = String(params.code || '').toUpperCase();
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [waiting, setWaiting] = useState(search.get('waiting') === '1');
  const [roomInfo, setRoomInfo] = useState<State | null>(null);
  // The name from the last answer that had it: once the class ends the state
  // answer no longer says who this is, and the greeting must keep the name.
  const [myName, setMyName] = useState('');
  // The class ended (or this seat was closed) while waiting in the lobby.
  const [lobbyEnded, setLobbyEnded] = useState(false);
  const [teacherSession, setTeacherSession] = useState<{ name: string | null } | null>(null);
  // Pressed Leave in the waiting room: stay out (no polling, no auto-rejoin) until "Rejoin".
  const [left, setLeft] = useState(() => {
    try {
      // A reload keeps the "left" page for 10 minutes; a later class link starts fresh.
      const at = typeof window !== 'undefined' ? Number(sessionStorage.getItem(leftKey(code)) || 0) : 0;
      return at > 0 && Date.now() - at < 10 * 60_000;
    } catch {
      return false;
    }
  });
  const [leftSchool, setLeftSchool] = useState(false);
  const [continueAsStudent, setContinueAsStudent] = useState(
    search.get('as') === 'student' || search.get('as') === '1'
  );

  const poll = useCallback(async () => {
    const res = await fetch(`/api/rooms/${code}/state?as=student`);
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || 'Room not found');
      return;
    }
    setRoomInfo(data);
    if (data.me?.displayName) setMyName(data.me.displayName);
    if (lobbyEndedFor(data)) setLobbyEnded(true);
    if (data.me?.viaSchoolApp) markSchoolStudentTab();
    if (data.teacherSessionActive) {
      setTeacherSession({ name: data.teacherSessionName || null });
    }
    if (data.me?.status === 'ADMITTED' && data.me?.role === 'STUDENT') {
      rememberClassroomRole(code, 'student');
      router.replace(`/classroom/${code}`);
    } else if (data.me?.status === 'WAITING' && data.me?.role === 'STUDENT') {
      setWaiting(true);
    }
  }, [code, router]);

  useEffect(() => {
    if (!left) poll();
  }, [poll, left]);

  useEffect(() => {
    fetch('/api/auth/act-as')
      .then((r) => r.json())
      .then((d) => {
        if (d.teacherSignedIn) {
          setTeacherSession({ name: d.teacherName || null });
          if (d.actAs === 'student') setContinueAsStudent(true);
        }
      })
      .catch(() => {});
  }, []);

  const hidden = usePageHidden();
  useEffect(() => {
    if (!waiting || lobbyEnded || left) return;
    // Back off while the tab is hidden; check at once when it comes back.
    if (!hidden) void poll();
    const t = setInterval(poll, waitingPollMs(hidden));
    return () => clearInterval(t);
  }, [waiting, poll, hidden, lobbyEnded]);

  async function leaveWaiting() {
    const school = !!roomInfo?.me?.viaSchoolApp;
    setLeftSchool(school);
    setLeft(true);
    try {
      sessionStorage.setItem(leftKey(code), String(Date.now()));
      sessionStorage.setItem(leftKey(code) + '_school', school ? '1' : '0');
    } catch {
      /* ignore */
    }
    // Cancel the waiting request (the teacher no longer sees this student waiting).
    await fetch(`/api/rooms/${code}/leave`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => null);
  }

  function rejoin() {
    let school = leftSchool;
    try {
      school = school || sessionStorage.getItem(leftKey(code) + '_school') === '1';
      sessionStorage.removeItem(leftKey(code));
      sessionStorage.removeItem(leftKey(code) + '_school');
    } catch {
      /* ignore */
    }
    // School-app students go back through their class route (it seats them again).
    if (school) {
      window.location.href = '/student';
      return;
    }
    window.location.href = `/join/${code}`;
  }

  async function enableStudentMode() {
    await fetch('/api/auth/act-as', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'student' }),
    });
    setContinueAsStudent(true);
    const url = new URL(window.location.href);
    url.searchParams.set('as', 'student');
    window.history.replaceState({}, '', url.toString());
  }

  async function joinAsDifferentStudent() {
    setError('');
    await fetch('/api/auth/clear-student', { method: 'POST' });
    setWaiting(false);
    setRoomInfo((prev) => (prev ? { ...prev, me: undefined } : prev));
    setDisplayName('');
  }

  async function join(e: React.FormEvent) {
    e.preventDefault();
    if (teacherSession && !continueAsStudent) {
      setError('Confirm you want to continue as a student in this tab first.');
      return;
    }
    setLoading(true);
    setError('');
    await fetch('/api/auth/act-as', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'student' }),
    });
    setContinueAsStudent(true);
    rememberClassroomRole(code, 'student');
    const res = await fetch(`/api/rooms/${code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.error || 'Could not join');
      return;
    }
    setWaiting(true);
    poll();
  }

  if (left) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6" data-finished="left" data-testid="left-page">
        <div className="max-w-md rounded-2xl border border-white/10 bg-surface-1 p-8 text-center shadow-lift">
          <p className="font-display text-2xl font-semibold tracking-tight">You left the class</p>
          <p className="mt-2 text-sm text-slate-400">You are no longer waiting to be admitted. Rejoin when you are ready.</p>
          <Button className="mt-6" onClick={rejoin} data-testid="rejoin">
            Rejoin
          </Button>
        </div>
      </main>
    );
  }

  // Until the first poll says who this is (or while an admitted student is
  // being sent into the class), show a neutral state, not a nameless lobby.
  if (waiting && lobbyEnded) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center px-5 py-10 text-center sm:px-6">
        <Card className="w-full p-10 text-center">
          <h1 className="font-display text-2xl font-semibold tracking-tight">Class ended</h1>
          <p className="mt-3 text-slate-300">
            {myName ? `Sorry, ${myName} — ` : ''}
            <strong className="text-white">{roomInfo?.name || code}</strong> has ended before you were let in.
          </p>
          <p className="mt-2 text-sm text-slate-400">You can close this tab.</p>
        </Card>
        <Link
          href={roomInfo?.me?.viaSchoolApp ? '/student' : '/'}
          className="mt-6 text-sm text-slate-500 transition hover:text-slate-300"
        >
          Back
        </Link>
      </main>
    );
  }

  if (waiting && !error && (!roomInfo || roomInfo.me?.status === 'ADMITTED')) {
    return <PageLoading label={roomInfo ? 'Entering class…' : 'Joining class…'} />;
  }

  if (waiting) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center px-5 py-10 text-center sm:px-6">
        <Card className="w-full p-10 text-center">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-brand-500/15 ring-1 ring-brand-400/30">
            <span className="indicator-pulse scale-150">
              <span />
            </span>
          </div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Waiting room</h1>
          <p className="mt-3 text-slate-300">
            Hi{(roomInfo?.me?.displayName || myName) ? `, ${roomInfo?.me?.displayName || myName}` : ''} — you&apos;re in the
            lobby for <strong className="text-white">{roomInfo?.name || code}</strong>.
          </p>
          <p className="mt-2 text-sm text-slate-400">
            Your teacher will admit you shortly. Keep this tab open.
          </p>
          {roomInfo?.classFull && (
            <p className="mt-3 text-sm font-semibold text-amber-200" role="status">
              This class is full.
            </p>
          )}
          {!roomInfo?.me?.viaSchoolApp && (
            <Button type="button" variant="secondary" className="mt-6 w-full" onClick={joinAsDifferentStudent}>
              Not you? Join with a different name
            </Button>
          )}
          {!roomInfo?.me?.viaSchoolApp && (
            <p className="mt-8 font-display text-3xl tracking-[0.3em] text-brand-300">{code}</p>
          )}
        </Card>
        <button type="button" data-testid="waiting-leave" onClick={() => void leaveWaiting()} className="mt-6 text-sm text-slate-500 transition hover:text-slate-300">
          Leave
        </button>
      </main>
    );
  }

  // Manual code + name joining is off (default): students come from the school app.
  if (roomInfo && roomInfo.manualJoinAllowed === false && !roomInfo.me) {
    return <SchoolAppOnly />;
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10 sm:px-6">
      <BackLink href="/join">Change code</BackLink>

      {teacherSession && !continueAsStudent && (
        <div className="mb-4 rounded-2xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <p className="font-medium">
            You&apos;re signed in as a teacher
            {teacherSession.name ? ` (${teacherSession.name})` : ''}.
          </p>
          <p className="mt-1 text-amber-100/80">
            Continue as student for this tab — you won&apos;t be redirected into the teacher classroom
            from this join link.
          </p>
          <Button variant="secondary" className="mt-3 w-full" onClick={enableStudentMode}>
            Continue as student for this tab
          </Button>
        </div>
      )}

      {teacherSession && continueAsStudent && (
        <div className="mb-4 rounded-2xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-2.5 text-xs text-emerald-100">
          Joining as student in this tab (teacher session kept for other tabs).
        </div>
      )}

      <Card>
        <p className="text-2xs font-semibold uppercase tracking-widest text-slate-500">Joining</p>
        <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight">
          {roomInfo?.name || 'Class'}
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Room <span className="font-mono text-brand-300">{code}</span>
          {roomInfo?.teacherName ? ` · ${roomInfo.teacherName}` : ''}
        </p>
        {roomInfo?.status === 'ENDED' ? (
          <p className="mt-6 text-warning-fg">This class has ended.</p>
        ) : (
          <form onSubmit={join} className="mt-6 space-y-4">
            <Input
              label="Your display name"
              name="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Maya Chen"
              required
              maxLength={60}
              disabled={!!teacherSession && !continueAsStudent}
            />
            {error && (
              <p className="text-sm text-danger-fg" role="alert">
                {error}
              </p>
            )}
            <Button
              type="submit"
              fullWidth
              className="py-3"
              disabled={loading || (!!teacherSession && !continueAsStudent)}
            >
              {loading ? 'Joining…' : 'Enter waiting room'}
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}

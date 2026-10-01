'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppHeader } from '@/components/layout/AppHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { PageLoading } from '@/components/ui/Skeleton';
import { claimTeacherTab } from '@/lib/classroomClient';
import { api } from '@/lib/clientFetch';

type Me = { role: string; name?: string; email?: string; permanentCode?: string; mustChangePassword?: boolean };
type ClassItem = {
  key: string;
  date: string;
  subject: string;
  audience: string;
  startLabel: string;
  endLabel: string;
  opensAt: string;
  phase: 'upcoming' | 'open' | 'past';
  mine: boolean;
  substituteFor: string | null;
  coveredBy: string | null;
  extra: boolean;
  note: string | null;
  canStart: boolean;
  session: { id: string; startedAt: string | null; endedAt: string | null; live: boolean } | null;
};
type Schedule = {
  timezone: string;
  earlyMinutes: number;
  today: string;
  classes: ClassItem[];
  active: { id: string | null; subject: string; audience: string; adHoc: boolean; code: string } | null;
  assignments: { grade: string; division: string; label: string }[];
};

function fmtDate(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export default function TeacherDashboard() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [maxVisible, setMaxVisible] = useState(6);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [adhoc, setAdhoc] = useState({ grade: '', divisions: [] as string[], all: false, extra: '', subject: '' });

  useEffect(() => {
    fetch('/api/auth/act-as', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'clear' }),
    }).catch(() => {});
  }, []);

  useEffect(() => {
    api<Me>('/api/auth/me').then(({ data }) => {
      if (data.role !== 'teacher') router.replace('/login');
      else if (data.mustChangePassword) router.replace('/account/password');
      else setMe(data);
    });
  }, [router]);

  const loadSchedule = useCallback(async () => {
    const { ok, data } = await api<Schedule>('/api/teacher/schedule');
    if (ok) setSchedule(data);
  }, []);

  useEffect(() => {
    if (!me) return;
    void loadSchedule();
    const t = setInterval(loadSchedule, 30_000);
    return () => clearInterval(t);
  }, [me, loadSchedule]);

  const grades = useMemo(() => [...new Set((schedule?.assignments ?? []).map((a) => a.grade))], [schedule]);
  const gradeDivs = useMemo(
    () => (schedule?.assignments ?? []).filter((a) => a.grade === adhoc.grade).map((a) => a.division),
    [schedule, adhoc.grade]
  );
  const wholeGrade = gradeDivs.includes('*');

  useEffect(() => {
    if (!adhoc.grade && grades.length) setAdhoc((a) => ({ ...a, grade: grades[0]! }));
  }, [grades, adhoc.grade]);

  async function go(code: string) {
    await claimTeacherTab(code);
    router.push(`/classroom/${code}`);
  }

  async function start(body: Record<string, unknown>, id: string) {
    setBusy(id);
    setError('');
    const { ok, data } = await api<{ code: string }>('/api/teacher/sessions/start', {
      body: { ...body, maxVisibleVideos: maxVisible },
    });
    if (!ok) {
      setBusy(null);
      setError(data.error || 'Could not start the class');
      void loadSchedule();
      return;
    }
    await go(data.code);
  }

  function startAdhoc(e: React.FormEvent) {
    e.preventDefault();
    const extra = adhoc.extra
      .split(/[,\s]+/)
      .map((d) => d.trim())
      .filter(Boolean);
    const divisions = [...adhoc.divisions.filter((d) => d !== '*'), ...extra];
    if (!adhoc.all && !divisions.length) {
      setError('Pick at least one division.');
      return;
    }
    void start(
      { kind: 'adhoc', grade: adhoc.grade, divisions, allDivisions: adhoc.all, subject: adhoc.subject || undefined },
      'adhoc'
    );
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/');
  }

  async function copyCode() {
    if (!me?.permanentCode) return;
    await navigator.clipboard.writeText(me.permanentCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!me) return <PageLoading label="Loading dashboard…" />;

  const today = (schedule?.classes ?? []).filter((c) => c.date === schedule?.today);
  const later = (schedule?.classes ?? []).filter((c) => c.date !== schedule?.today && c.mine);
  const laterByDate = later.reduce<Record<string, ClassItem[]>>((acc, c) => {
    (acc[c.date] ||= []).push(c);
    return acc;
  }, {});

  return (
    <main className="page-shell max-w-4xl">
      <AppHeader
        compact
        subtitle="Teacher dashboard"
        right={
          <>
            <Link href="/account/password" className="btn-ghost px-3 py-1.5 text-xs">
              Change password
            </Link>
            <Button variant="secondary" onClick={logout}>
              Log out
            </Button>
          </>
        }
      />

      <div className="mb-6">
        <p className="text-sm text-slate-400">Signed in as</p>
        <h1 className="font-display text-2xl font-semibold tracking-tight">{me.name}</h1>
        <p className="text-sm text-slate-400">{me.email}</p>
      </div>

      {error && (
        <p className="mb-4 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm text-danger-fg" role="alert">
          {error}
        </p>
      )}

      {schedule?.active && (
        <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-emerald-400/25 bg-emerald-500/10 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Badge tone="success" pulse>
              Class open
            </Badge>
            <p className="mt-2 font-semibold text-white">
              {schedule.active.subject}
              {schedule.active.audience && !schedule.active.subject.includes(schedule.active.audience)
                ? ` · ${schedule.active.audience}`
                : ''}
            </p>
          </div>
          <Button onClick={() => void go(schedule.active!.code)}>Return to classroom</Button>
        </div>
      )}

      <Card className="mb-6">
        <CardHeader
          title="Today"
          subtitle={
            schedule
              ? `${fmtDate(schedule.today)} · the waiting room opens ${schedule.earlyMinutes} min before each class`
              : 'Loading…'
          }
        />
        {!schedule ? null : today.length === 0 ? (
          <p className="text-sm text-slate-400">No timetabled classes today. You can start an ad-hoc class below.</p>
        ) : (
          <ul className="divide-y divide-white/5">
            {today.map((c) => (
              <ClassRow key={c.key} c={c} busy={busy === c.key} onStart={() => void start({ kind: 'scheduled', key: c.key }, c.key)} />
            ))}
          </ul>
        )}
      </Card>

      {Object.keys(laterByDate).length > 0 && (
        <Card className="mb-6">
          <CardHeader title="Coming up" subtitle="Next 6 days" />
          <div className="space-y-4">
            {Object.entries(laterByDate).map(([date, items]) => (
              <div key={date}>
                <p className="mb-1 text-2xs font-semibold uppercase tracking-wider text-slate-500">{fmtDate(date)}</p>
                <ul className="space-y-1 text-sm">
                  {items.map((c) => (
                    <li key={c.key} className="flex flex-wrap gap-x-3 text-slate-300">
                      <span className="font-mono text-brand-300">
                        {c.startLabel}–{c.endLabel}
                      </span>
                      <span className="font-medium text-white">{c.subject}</span>
                      <span>{c.audience}</span>
                      {c.substituteFor && <span className="text-amber-200">substituting for {c.substituteFor}</span>}
                      {c.extra && <span className="text-emerald-200">extra class</span>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="mb-6">
        <CardHeader
          title="Ad-hoc class"
          subtitle="Outside the timetable, for your assigned grades and divisions only. Students of those divisions are routed here from the school app."
        />
        {!schedule ? null : grades.length === 0 ? (
          <p className="text-sm text-slate-400">No grades are assigned to you yet. Ask the school administrator.</p>
        ) : (
          <form onSubmit={startAdhoc} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="label">Grade</span>
                <select
                  className="input"
                  value={adhoc.grade}
                  onChange={(e) => setAdhoc({ ...adhoc, grade: e.target.value, divisions: [], all: false, extra: '' })}
                >
                  {grades.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </label>
              <Input
                label="Subject / title"
                name="subject"
                value={adhoc.subject}
                onChange={(e) => setAdhoc({ ...adhoc, subject: e.target.value })}
                placeholder="e.g. Revision"
                maxLength={80}
              />
            </div>
            <fieldset>
              <legend className="label">Divisions</legend>
              <div className="flex flex-wrap gap-3">
                {gradeDivs
                  .filter((d) => d !== '*')
                  .map((d) => (
                    <label key={d} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        disabled={adhoc.all}
                        checked={adhoc.divisions.includes(d)}
                        onChange={(e) =>
                          setAdhoc({
                            ...adhoc,
                            divisions: e.target.checked ? [...adhoc.divisions, d] : adhoc.divisions.filter((x) => x !== d),
                          })
                        }
                      />
                      {adhoc.grade}-{d}
                    </label>
                  ))}
                {wholeGrade && (
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={adhoc.all} onChange={(e) => setAdhoc({ ...adhoc, all: e.target.checked })} />
                    All divisions of grade {adhoc.grade}
                  </label>
                )}
              </div>
              {wholeGrade && !adhoc.all && (
                <input
                  className="input mt-3 max-w-xs"
                  placeholder="Divisions, e.g. A, C"
                  value={adhoc.extra}
                  onChange={(e) => setAdhoc({ ...adhoc, extra: e.target.value })}
                  aria-label="Divisions"
                />
              )}
            </fieldset>
            <Input
              label="Max visible student videos"
              type="number"
              name="maxVisible"
              min={1}
              max={6}
              value={maxVisible}
              onChange={(e) => setMaxVisible(Number(e.target.value))}
              hint="Only this many student camera streams reach you. Others stay local-only on their devices."
            />
            <Button type="submit" disabled={busy === 'adhoc'}>
              {busy === 'adhoc' ? 'Starting…' : 'Start ad-hoc class'}
            </Button>
          </form>
        )}
      </Card>

      {me.permanentCode && (
        <Card>
          <CardHeader
            title="Your permanent class code"
            subtitle="Your classroom keeps this code for every class. Students join from the school app; the code is for staff and testing."
          />
          <div className="flex flex-wrap items-center gap-3">
            <p className="font-display text-3xl font-bold tracking-[0.28em] text-brand-300">{me.permanentCode}</p>
            <Button variant="secondary" size="sm" onClick={copyCode}>
              {copied ? 'Copied!' : 'Copy code'}
            </Button>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            {schedule ? `Times shown in your device’s time zone; the school timetable uses ${schedule.timezone}.` : ''}
          </p>
        </Card>
      )}
    </main>
  );
}

function ClassRow({ c, busy, onStart }: { c: ClassItem; busy: boolean; onStart: () => void }) {
  let status: React.ReactNode;
  if (!c.mine) status = <Badge tone="neutral">Covered by {c.coveredBy}</Badge>;
  else if (c.session?.live) status = <Badge tone="success" pulse>Live</Badge>;
  else if (c.session?.endedAt && c.phase !== 'past') status = <Badge tone="neutral">Ended · can reopen</Badge>;
  else if (c.phase === 'open') status = <Badge tone="success">Open now</Badge>;
  else if (c.phase === 'upcoming') status = <Badge tone="sky">Opens {fmtTime(c.opensAt)}</Badge>;
  else status = <Badge tone="neutral">{c.session?.startedAt ? 'Held' : 'Not held'}</Badge>;

  return (
    <li className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="font-mono text-sm text-brand-300">
          {c.startLabel}–{c.endLabel}
        </p>
        <p className="font-semibold text-white">
          {c.subject} <span className="font-normal text-slate-400">· {c.audience}</span>
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
          {status}
          {c.substituteFor && <span className="text-amber-200">Substituting for {c.substituteFor}</span>}
          {c.extra && <span className="text-emerald-200">Extra class</span>}
          {c.note && <span>{c.note}</span>}
        </div>
      </div>
      {c.mine && (
        <Button onClick={onStart} disabled={!c.canStart || busy} className="sm:min-w-[9rem]">
          {busy ? 'Opening…' : c.session?.live ? 'Re-enter' : c.session?.startedAt && !c.session.endedAt ? 'Re-enter' : 'Start class'}
        </Button>
      )}
    </li>
  );
}

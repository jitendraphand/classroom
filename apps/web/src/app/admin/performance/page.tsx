'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { api } from '@/lib/clientFetch';
import { formatDate } from '@/lib/timeFormat';

type Rank = { percentile: number | null; weekStart: string; eligible: boolean; ratingCount: number } | null;
type Teacher = {
  teacherId: string;
  name: string;
  classes: number;
  lateStarts?: number;
  averageAttendance: number | null;
  averageStars: number | null;
  rank: Rank;
};
type Session = { id: string; subject: string; audience: string; date: string };
type Feedback = { studentName: string; rollNumber: string | null; stars: number; comment: string | null };

function pct(n: number | null) {
  if (n == null) return '—';
  return `${Math.round(n * 1000) / 10}%`;
}

export default function PerformancePage() {
  return (
    <AdminShell title="Teacher performance">
      <Performance />
    </AdminShell>
  );
}

function Performance() {
  const [year, setYear] = useState('');
  const [years, setYears] = useState<string[]>([]);
  const [teachers, setTeachers] = useState<Teacher[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [feedback, setFeedback] = useState<Feedback[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    const qs = year ? `?year=${encodeURIComponent(year)}` : '';
    api<{ year: string; years: string[]; teachers: Teacher[] }>(`/api/admin/performance${qs}`).then(({ ok, data }) => {
      if (!ok) {
        setError(data.error || 'Could not load performance');
        return;
      }
      setYears(data.years);
      setTeachers(data.teachers);
      if (!year) setYear(data.year);
    });
  }, [year, tick]);

  async function openTeacher(id: string) {
    setOpen(id);
    setFeedback(null);
    const { ok, data } = await api<{ sessions: Session[] }>(`/api/admin/performance?sessionsFor=${id}&year=${encodeURIComponent(year)}`);
    setSessions(ok ? data.sessions : []);
  }

  async function openFeedback(sessionId: string) {
    const { ok, data } = await api<{ feedback: Feedback[] }>(`/api/admin/performance/feedback?sessionId=${sessionId}`);
    setFeedback(ok ? data.feedback : []);
  }

  async function recompute() {
    setBusy(true);
    setError('');
    const { ok, data } = await api('/api/admin/rankings/recompute', { method: 'POST', body: { academicYear: year } });
    setBusy(false);
    if (!ok) setError(data.error || 'Could not recompute');
    else setTick((n) => n + 1);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="block text-sm">
          <span className="label">Academic year</span>
          <select className="input" value={year} onChange={(e) => setYear(e.target.value)}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-slate-400">
          Ranks update automatically every week.{' '}
          <button type="button" className="text-brand-300 hover:underline disabled:opacity-50" disabled={busy || !year} onClick={() => void recompute()}>
            {busy ? 'Updating…' : 'Update now'}
          </button>
        </p>
      </div>
      {error && <p className="text-sm text-red-300">{error}</p>}
      <Card>
        <CardHeader
          title="Teachers"
          subtitle="Classes held this year, how many started late, attendance, stars and this week's rank. Open Attendance for classes that were not held."
        />
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-slate-400">
              <tr>
                <th className="py-2 pr-3 font-medium">Teacher</th>
                <th className="py-2 pr-3 font-medium">Classes held</th>
                <th className="py-2 pr-3 font-medium">Started late</th>
                <th className="py-2 pr-3 font-medium">Avg attendance</th>
                <th className="py-2 pr-3 font-medium">Avg stars</th>
                <th className="py-2 pr-3 font-medium">Rank</th>
                <th className="py-2 font-medium">
                  <span className="sr-only">Attendance</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(teachers ?? []).map((t) => (
                <tr key={t.teacherId} className="border-t border-white/5">
                  <td className="py-2 pr-3">
                    <button type="button" className="text-brand-300 hover:underline" onClick={() => void openTeacher(t.teacherId)}>
                      {t.name}
                    </button>
                  </td>
                  <td className="py-2 pr-3">{t.classes}</td>
                  <td className={t.lateStarts ? 'py-2 pr-3 text-amber-200' : 'py-2 pr-3'}>{t.lateStarts ?? 0}</td>
                  <td className="py-2 pr-3">{pct(t.averageAttendance)}</td>
                  <td className="py-2 pr-3">{t.averageStars ?? '—'}</td>
                  <td className="py-2 pr-3">
                    {t.rank?.percentile == null ? 'Not enough ratings' : `${t.rank.percentile}th · week of ${formatDate(t.rank.weekStart, { weekday: false })}`}
                  </td>
                  <td className="py-2">
                    <Link className="inline-flex min-h-6 items-center text-xs text-brand-300 hover:underline" href={`/admin/reports?teacherId=${encodeURIComponent(t.teacherId)}`}>
                      Attendance
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {open && (
        <Card>
          <CardHeader title="Classes" subtitle="Open a class to read individual feedback. Only administrators see the written text." />
          <ul className="divide-y divide-white/5">
            {sessions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {formatDate(s.date)} · {s.subject} · {s.audience}
                </span>
                <Button size="sm" variant="secondary" onClick={() => void openFeedback(s.id)}>
                  Feedback
                </Button>
              </li>
            ))}
            {sessions.length === 0 && <li className="py-2 text-slate-400">No conducted classes in this year.</li>}
          </ul>
          {feedback && (
            <ul className="mt-4 space-y-2">
              {feedback.length === 0 && <li className="text-sm text-slate-400">No feedback yet.</li>}
              {feedback.map((f, i) => (
                <li key={i} className="rounded-xl border border-white/10 px-3 py-2 text-sm">
                  <p className="font-medium">
                    {f.studentName}
                    {f.rollNumber ? ` · ${f.rollNumber}` : ''} · {f.stars}★
                  </p>
                  {f.comment && <p className="text-slate-300">{f.comment}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

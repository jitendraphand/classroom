'use client';

import { useEffect, useRef, useState } from 'react';
import { Card, CardHeader } from '@/components/ui/Card';
import { api } from '@/lib/clientFetch';

type Tone = 'taken' | 'today' | 'upcoming' | 'skipped';
type Home = {
  year: string;
  years: { label: string; active: boolean }[];
  month: string;
  prevMonth: string;
  nextMonth: string;
  legend: Record<Tone, string>;
  kpis: {
    sessionsConducted: number;
    averageAttendance: number | null;
    averageRating: number | null;
    rank: { percentile: number | null; weekStart: string; eligible: boolean; ratingCount: number } | null;
  };
  calendar: { date: string; items: { key: string; subject: string; tone: Tone; start: string }[] }[];
  sessions: {
    id: string | null;
    date: string;
    subject: string;
    audience: string;
    attendance: string;
    avgStars: number | null;
    tone: Tone;
  }[];
};

const TONE_CLASS: Record<Tone, string> = {
  taken: 'bg-emerald-400',
  today: 'bg-amber-300',
  upcoming: 'bg-sky-400',
  skipped: 'bg-slate-500',
};

export function TeacherInsights({ year, onYear }: { year: string; onYear: (year: string) => void }) {
  const [month, setMonth] = useState('');
  const [home, setHome] = useState<Home | null>(null);
  const [filters, setFilters] = useState({ from: '', to: '', grade: '', division: '', subject: '', status: '' });
  const onYearRef = useRef(onYear);
  onYearRef.current = onYear;

  useEffect(() => {
    const p = new URLSearchParams();
    if (year) p.set('year', year);
    if (month) p.set('month', month);
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    let cancelled = false;
    api<Home>(`/api/teacher/home?${p}`).then(({ ok, data }) => {
      if (!ok || cancelled) return;
      setHome(data);
      if (!year) onYearRef.current(data.year);
      if (!month) setMonth(data.month);
    });
    return () => {
      cancelled = true;
    };
  }, [year, month, filters]);

  if (!home) return <p className="mb-6 text-sm text-slate-400">Loading your classes…</p>;

  const rank = home.kpis.rank;
  const rankLabel =
    !rank || rank.percentile == null
      ? 'Not enough ratings yet'
      : `${rank.percentile}th percentile · week of ${rank.weekStart}`;

  return (
    <div className="mb-8 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <label className="block text-sm">
          <span className="label">Academic year</span>
          <select className="input" value={home.year} onChange={(e) => onYear(e.target.value)}>
            {home.years.map((y) => (
              <option key={y.label} value={y.label}>
                {y.label}
                {!y.active ? ' (inactive)' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Sessions conducted" value={String(home.kpis.sessionsConducted)} />
        <Kpi label="Average attendance" value={home.kpis.averageAttendance == null ? '—' : `${Math.round(home.kpis.averageAttendance * 1000) / 10}%`} />
        <Kpi label="Average rating" value={home.kpis.averageRating == null ? '—' : `${home.kpis.averageRating}★`} />
        <Kpi label="Your rank" value={rankLabel} />
      </div>

      <Card>
        <CardHeader
          title="Calendar"
          subtitle={home.month}
          action={
            <span className="flex gap-2">
              <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setMonth(home.prevMonth)}>
                Previous
              </button>
              <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setMonth(home.nextMonth)}>
                Next
              </button>
            </span>
          }
        />
        <div className="mb-3 flex flex-wrap gap-3 text-xs text-slate-300">
          {(Object.keys(TONE_CLASS) as Tone[]).map((tone) => (
            <span key={tone} className="inline-flex items-center gap-1.5">
              <span className={`h-2.5 w-2.5 rounded-full ${TONE_CLASS[tone]}`} />
              {home.legend[tone]}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1 text-center text-2xs text-slate-500">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
            <div key={d}>{d}</div>
          ))}
        </div>
        <div className="mt-1 grid grid-cols-7 gap-1">
          {pad(home.calendar).map((day, i) =>
            day ? (
              <div key={day.date} className="min-h-[4.5rem] rounded-lg border border-white/5 p-1">
                <p className="text-2xs text-slate-400">{Number(day.date.slice(8))}</p>
                {day.items.slice(0, 3).map((item: Home['calendar'][number]['items'][number]) => (
                  <p key={item.key} className="truncate text-[10px] text-slate-200" title={`${item.start} ${item.subject}`}>
                    <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${TONE_CLASS[item.tone]}`} />
                    {item.subject}
                  </p>
                ))}
              </div>
            ) : (
              <div key={`e${i}`} />
            )
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Sessions" subtitle="Stars are the average of students who were present. Written comments stay with the school administrator." />
        <div className="mb-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <input className="input" type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} aria-label="From" />
          <input className="input" type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} aria-label="To" />
          <input className="input" placeholder="Grade" value={filters.grade} onChange={(e) => setFilters({ ...filters, grade: e.target.value })} />
          <input className="input" placeholder="Division" value={filters.division} onChange={(e) => setFilters({ ...filters, division: e.target.value })} />
          <input className="input" placeholder="Subject" value={filters.subject} onChange={(e) => setFilters({ ...filters, subject: e.target.value })} />
          <select className="input" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} aria-label="Status">
            <option value="">Any status</option>
            <option value="taken">Taken / completed</option>
            <option value="today">Today&apos;s scheduled</option>
            <option value="upcoming">Upcoming</option>
            <option value="skipped">Not taken / skipped</option>
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-slate-400">
              <tr>
                <th className="py-2 pr-3 font-medium">Date</th>
                <th className="py-2 pr-3 font-medium">Class</th>
                <th className="py-2 pr-3 font-medium">Attendance</th>
                <th className="py-2 font-medium">Avg stars</th>
              </tr>
            </thead>
            <tbody>
              {home.sessions.map((s) => (
                <tr key={`${s.date}-${s.subject}-${s.audience}`} className="border-t border-white/5">
                  <td className="py-2 pr-3 whitespace-nowrap">{s.date}</td>
                  <td className="py-2 pr-3">
                    {s.subject}
                    <span className="text-slate-400"> · {s.audience}</span>
                  </td>
                  <td className="py-2 pr-3">{s.attendance}</td>
                  <td className="py-2">{s.avgStars ?? '—'}</td>
                </tr>
              ))}
              {home.sessions.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-3 text-slate-400">
                    No classes match those filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 font-display text-lg font-semibold text-white">{value}</p>
    </div>
  );
}

/** Monday-first blanks before the first of the month. */
function pad(days: Home['calendar']) {
  if (!days.length) return days;
  const first = new Date(`${days[0]!.date}T00:00:00Z`).getUTCDay();
  const lead = first === 0 ? 6 : first - 1;
  return [...Array(lead).fill(null), ...days];
}

'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader } from '@/components/ui/Card';
import { api } from '@/lib/clientFetch';
import { formatDate } from '@/lib/timeFormat';

type Row = {
  key: string;
  subject: string;
  audience: string;
  teacherName: string;
  start: string;
  end: string;
  tag: 'ongoing' | 'late' | 'not_taken' | 'starts' | 'completed';
  lateMinutes?: number;
  roomCode: string | null;
};

const TAG: Record<Row['tag'], { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'brand' }> = {
  ongoing: { label: 'Live', tone: 'success' },
  late: { label: 'Late', tone: 'warning' },
  not_taken: { label: 'Not held', tone: 'danger' },
  starts: { label: 'Starts', tone: 'brand' },
  completed: { label: 'Done', tone: 'neutral' },
};

function tagLabel(r: Row): string {
  if (r.tag === 'starts') return `Starts at ${r.start}`;
  if (r.tag === 'late') return `Late · teacher not in yet (${r.lateMinutes ?? 0} min)`;
  return TAG[r.tag].label;
}

export default function AdminTodayPage() {
  return (
    <AdminShell title="Today's classes">
      <TodayBoard />
    </AdminShell>
  );
}

function TodayBoard() {
  const [year, setYear] = useState('');
  const [years, setYears] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [today, setToday] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const qs = year ? `?year=${encodeURIComponent(year)}` : '';
    const load = () =>
      api<{ today: string; year: string; years: string[]; classes: Row[] }>(`/api/admin/today${qs}`).then(({ ok, data }) => {
        if (!ok) {
          setError(data.error || 'Could not load today');
          return;
        }
        setError('');
        setYears(data.years);
        setToday(data.today);
        setRows(data.classes);
        if (!year) setYear(data.year);
      });
    void load();
    // Late and live states change by the minute.
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [year]);

  const count = (tag: Row['tag']) => rows?.filter((r) => r.tag === tag).length ?? 0;
  const summary = rows
    ? [
        [count('ongoing'), 'live'],
        [count('late'), 'late'],
        [count('starts'), 'later today'],
        [count('completed'), 'done'],
        [count('not_taken'), 'not held'],
      ]
        .filter(([n]) => Number(n) > 0)
        .map(([n, l]) => `${n} ${l}`)
        .join(' · ')
    : '';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-medium text-white">{today ? formatDate(today, { long: true, year: true }) : 'Loading…'}</p>
          {summary && <p className="mt-0.5 text-sm text-slate-400">{summary}</p>}
        </div>
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
      </div>
      {error && <p className="text-sm text-red-300">{error}</p>}
      <Card>
        <CardHeader title="Schedule" subtitle="Refreshes every 30 seconds. Late = the class should have started and the teacher is not in yet." />
        {!rows ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-400">Nothing is scheduled today.</p>
        ) : (
          <ul className="divide-y divide-white/5">
            {rows.map((r) => {
              const tag = TAG[r.tag];
              const label = tagLabel(r);
              return (
                <li key={r.key} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="font-medium text-white">
                      {r.subject} <span className="text-slate-400">· {r.audience}</span>
                    </p>
                    <p className="text-sm text-slate-400">
                      {r.teacherName} · {r.start}–{r.end}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={tag.tone} pulse={r.tag === 'ongoing'}>
                      {label}
                    </Badge>
                    {r.tag === 'ongoing' && r.roomCode && (
                      <Link href={`/admin/live/${r.roomCode}`} className="btn-secondary px-3 py-1.5 text-xs">
                        Monitor
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

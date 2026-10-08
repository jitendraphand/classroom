'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CampusSelect, DivisionSelect, GradeSelect, useGradeOptions } from '@/components/admin/GradePickers';
import { api } from '@/lib/clientFetch';
import { cn } from '@/lib/cn';

type Kind = 'sessions' | 'students' | 'detail';

type SessionRow = {
  sessionId: string | null;
  date: string;
  subject: string;
  teacher: string;
  audience: string;
  type: string;
  scheduledStart: string;
  scheduledEnd: string;
  startedAt: string;
  endedAt: string;
  startDelayMin: number | null;
  status: string;
  present: number;
  late: number;
  notAdmitted: number;
  absent: number;
  knownStudents: number;
};
type StudentRow = {
  studentId: string;
  externalId: string;
  name: string;
  rollNumber: string;
  gradeDivision: string;
  classes: number;
  present: number;
  late: number;
  notAdmitted: number;
  absent: number;
  attendancePct: number | null;
  connectedMin: number;
};
type DetailRow = {
  sessionId: string;
  date: string;
  subject: string;
  audience: string;
  teacher: string;
  externalId: string;
  name: string;
  rollNumber: string;
  gradeDivision: string;
  status: string;
  statusLabel: string;
  firstJoined: string;
  admitted: string;
  left: string;
  connectedMin: number;
};

function isoDay(offset = 0) {
  const d = new Date(Date.now() + offset * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  present: 'success',
  late: 'warning',
  not_admitted: 'neutral',
  absent: 'danger',
};

/**
 * Attendance reports (admin: all teachers; teacher: own sessions only).
 * `base` is /api/admin/reports or /api/teacher/attendance.
 */
export function ReportView({
  base,
  teachers,
  showTeacherFilter,
}: {
  base: string;
  teachers?: { id: string; name: string }[];
  showTeacherFilter?: boolean;
}) {
  const [kind, setKind] = useState<Kind>('sessions');
  const [filter, setFilter] = useState({ from: isoDay(-30), to: isoDay(0), teacherId: '', campus: '', grade: '', division: '', subject: '', sessionId: '' });
  const [rows, setRows] = useState<unknown[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const gradeOptions = useGradeOptions();

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v) p.set(k, v);
    return p.toString();
  }, [filter]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const { ok, data } = await api<{ rows: unknown[]; total?: number }>(`${base}/${kind}?${qs}`);
    setLoading(false);
    if (!ok) {
      setError(data.error || 'Could not load the report');
      setRows([]);
      return;
    }
    setRows(data.rows);
    setTotal(data.total ?? null);
  }, [base, kind, qs]);

  useEffect(() => {
    void load();
  }, [load]);

  const set = (k: keyof typeof filter) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setFilter({ ...filter, [k]: e.target.value });

  return (
    <div className="space-y-5">
      <Card>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-7">
          <label className="block">
            <span className="label">From</span>
            <input className="input px-2" type="date" value={filter.from} onChange={set('from')} />
          </label>
          <label className="block">
            <span className="label">To</span>
            <input className="input px-2" type="date" value={filter.to} onChange={set('to')} />
          </label>
          {showTeacherFilter && (
            <label className="block">
              <span className="label">Teacher</span>
              <select className="input" value={filter.teacherId} onChange={set('teacherId')}>
                <option value="">All</option>
                {(teachers ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block">
            <span className="label">Campus</span>
            <CampusSelect value={filter.campus} onChange={(c) => setFilter({ ...filter, campus: c })} options={gradeOptions} emptyLabel="Any" />
          </label>
          <label className="block">
            <span className="label">Grade</span>
            <GradeSelect value={filter.grade} onChange={(g) => setFilter({ ...filter, grade: g, division: '' })} options={gradeOptions} emptyLabel="Any" />
          </label>
          <label className="block">
            <span className="label">Division</span>
            <DivisionSelect grade={filter.grade} value={filter.division} onChange={(d) => setFilter({ ...filter, division: d })} options={gradeOptions} emptyLabel="Any" />
          </label>
          <label className="block">
            <span className="label">Subject</span>
            <input className="input" value={filter.subject} onChange={set('subject')} placeholder="Any" />
          </label>
        </div>
        {filter.sessionId && (
          <p className="mt-3 text-sm text-slate-300">
            Showing one class.{' '}
            <button type="button" className="text-brand-300 hover:underline" onClick={() => setFilter({ ...filter, sessionId: '' })}>
              Show all
            </button>
          </p>
        )}
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-xl border border-white/10 p-1">
          {(
            [
              ['sessions', 'Per class'],
              ['students', 'Per student'],
              ['detail', 'Detail'],
            ] as [Kind, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={cn('rounded-lg px-3 py-1.5 text-sm font-medium', kind === k ? 'bg-brand-600 text-white' : 'text-slate-400 hover:text-white')}
            >
              {label}
            </button>
          ))}
        </div>
        <a className="btn-secondary px-3 py-1.5 text-xs" href={`${base}/${kind}?${qs}&format=csv`}>
          Download CSV
        </a>
      </div>

      {error && <p className="text-sm text-danger-fg">{error}</p>}

      <Card padding={false} className="overflow-x-auto">
        {loading && !rows ? (
          <p className="p-6 text-sm text-slate-400">Loading…</p>
        ) : !rows?.length ? (
          <p className="p-6 text-sm text-slate-400">Nothing in this range.</p>
        ) : kind === 'sessions' ? (
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="text-2xs uppercase tracking-wider text-slate-500">
              <tr className="border-b border-white/5">
                {['Date', 'Class', 'Teacher', 'Scheduled', 'Actual', 'Status', 'Present', 'Late', 'Waited', 'Absent', ''].map((h) => (
                  <th key={h} className="px-4 py-3 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {(rows as SessionRow[]).map((r, i) => (
                <tr key={r.sessionId ?? `n${i}`} className="align-top">
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-slate-300">{r.date}</td>
                  <td className="px-4 py-2.5">
                    <p className="font-medium text-white">{r.subject}</p>
                    <p className="text-xs text-slate-400">
                      {r.audience} · {r.type}
                    </p>
                  </td>
                  <td className="px-4 py-2.5 text-slate-300">{r.teacher}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs">{r.scheduledStart ? `${r.scheduledStart}–${r.scheduledEnd}` : '—'}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs">
                    {r.startedAt ? `${r.startedAt}–${r.endedAt || '…'}` : '—'}
                    {r.startDelayMin != null && r.startDelayMin > 0 && <span className="ml-1 text-amber-200">(+{r.startDelayMin}m)</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={r.status === 'Held' ? 'success' : r.status === 'Not held' ? 'danger' : 'neutral'}>{r.status}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-emerald-200">{r.present}</td>
                  <td className="px-4 py-2.5 text-amber-200">{r.late}</td>
                  <td className="px-4 py-2.5 text-slate-300">{r.notAdmitted}</td>
                  <td className="px-4 py-2.5 text-red-200" title={`${r.knownStudents} known students`}>
                    {r.absent}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.sessionId && (
                      <button
                        type="button"
                        className="text-xs text-brand-300 hover:underline"
                        onClick={() => {
                          setFilter({ ...filter, sessionId: r.sessionId! });
                          setKind('detail');
                        }}
                      >
                        Details
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : kind === 'students' ? (
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="text-2xs uppercase tracking-wider text-slate-500">
              <tr className="border-b border-white/5">
                {['Student', 'Roll', 'Class', 'Held', 'Present', 'Late', 'Waited', 'Absent', 'Attendance'].map((h) => (
                  <th key={h} className="px-4 py-3 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {(rows as StudentRow[]).map((r) => (
                <tr key={r.studentId}>
                  <td className="px-4 py-2.5">
                    <p className="font-medium text-white">{r.name}</p>
                    <p className="font-mono text-2xs text-slate-500">{r.externalId}</p>
                  </td>
                  <td className="px-4 py-2.5">{r.rollNumber}</td>
                  <td className="px-4 py-2.5">{r.gradeDivision}</td>
                  <td className="px-4 py-2.5">{r.classes}</td>
                  <td className="px-4 py-2.5 text-emerald-200">{r.present}</td>
                  <td className="px-4 py-2.5 text-amber-200">{r.late}</td>
                  <td className="px-4 py-2.5">{r.notAdmitted}</td>
                  <td className="px-4 py-2.5 text-red-200">{r.absent}</td>
                  <td className="px-4 py-2.5 font-semibold">{r.attendancePct == null ? '—' : `${r.attendancePct}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <>
            {total != null && total > rows.length && (
              <p className="px-4 pt-3 text-xs text-slate-400">Showing the first {rows.length} of {total} rows; download the CSV for all.</p>
            )}
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="text-2xs uppercase tracking-wider text-slate-500">
                <tr className="border-b border-white/5">
                  {['Date', 'Class', 'Student', 'Roll', 'Status', 'Joined', 'Admitted', 'Left', 'Connected'].map((h) => (
                    <th key={h} className="px-4 py-3 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {(rows as DetailRow[]).map((r) => (
                  <tr key={`${r.sessionId}-${r.externalId}`}>
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">{r.date}</td>
                    <td className="px-4 py-2">
                      <p className="text-white">{r.subject}</p>
                      <p className="text-xs text-slate-400">{r.audience}</p>
                    </td>
                    <td className="px-4 py-2">
                      {r.name} <span className="text-xs text-slate-500">({r.gradeDivision})</span>
                    </td>
                    <td className="px-4 py-2">{r.rollNumber}</td>
                    <td className="px-4 py-2">
                      <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.statusLabel}</Badge>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{r.firstJoined}</td>
                    <td className="px-4 py-2 font-mono text-xs">{r.admitted}</td>
                    <td className="px-4 py-2 font-mono text-xs">{r.left}</td>
                    <td className="px-4 py-2">{r.connectedMin} min</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>
      <p className="text-xs text-slate-500">
        Absent counts only students the classroom knows (they joined once from the school app, or were imported on the
        Students page). “Waited” = in the waiting room but never admitted. Late = arrived after the class start (the later
        of the scheduled and actual start) plus the grace period. <Button variant="ghost" size="sm" onClick={() => void load()}>Refresh</Button>
      </p>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { CampusSelect, DivisionSelect, DivisionsPicker, GradeSelect, defaultCampus, useGradeOptions } from '@/components/admin/GradePickers';
import { api } from '@/lib/clientFetch';
import { cn } from '@/lib/cn';

type Teacher = { id: string; name: string; disabled: boolean };
type Slot = {
  id: string;
  teacherId: string;
  teacherName: string;
  campus: string;
  grade: string;
  divisions: string[];
  allDivisions: boolean;
  audience: string;
  subject: string;
  weekday: number;
  start: string;
  end: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
};
type Override = {
  id: string;
  kind: 'CANCEL' | 'MODIFY' | 'EXTRA';
  date: string;
  slotLabel: string | null;
  teacherName: string | null;
  audience: string | null;
  subject: string | null;
  start: string | null;
  end: string | null;
  note: string | null;
};
type Data = { timezone: string; today: string; teachers: Teacher[]; slots: Slot[]; overrides: Override[] };

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const emptySlot = {
  teacherId: '',
  campus: '',
  grade: '',
  divisions: '',
  subject: '',
  weekday: 1,
  /** New slots: every picked day gets its own weekly slot. */
  weekdays: [1] as number[],
  start: '09:00',
  end: '09:45',
  effectiveFrom: '',
  effectiveTo: '',
};

export default function TimetablePage() {
  return (
    <AdminShell title="Timetable">
      <TimetableEditor />
    </AdminShell>
  );
}

function weekdayOfDate(date: string) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function TimetableEditor() {
  const [mode, setMode] = useState<'teacher' | 'grade'>('teacher');
  const [teacherId, setTeacherId] = useState('');
  const [campus, setCampus] = useState('');
  const [grade, setGrade] = useState('');
  const [division, setDivision] = useState('');
  const [view, setView] = useState<Data | null>(null);
  const [all, setAll] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [slotForm, setSlotForm] = useState(emptySlot);
  const [editingId, setEditingId] = useState<string | null>(null);
  const gradeOptions = useGradeOptions();
  const [ov, setOv] = useState({
    kind: 'CANCEL' as Override['kind'],
    date: '',
    slotId: '',
    teacherId: '',
    campus: '',
    grade: '',
    divisions: '',
    subject: '',
    start: '',
    end: '',
    note: '',
  });

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (mode === 'teacher' && teacherId) qs.set('teacherId', teacherId);
    if (mode === 'grade' && grade) {
      if (campus) qs.set('campus', campus);
      qs.set('grade', grade);
      if (division) qs.set('division', division);
    }
    const [v, a] = await Promise.all([api<Data>(`/api/admin/timetable?${qs}`), api<Data>('/api/admin/timetable')]);
    if (v.ok) setView(v.data);
    else setError(v.data.error || 'Could not load timetable');
    if (a.ok) setAll(a.data);
  }, [mode, teacherId, campus, grade, division]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (all && !ov.date) setOv((o) => ({ ...o, date: all.today }));
  }, [all, ov.date]);

  const showGrid = mode === 'teacher' ? !!teacherId : !!grade;
  const byDay = useMemo(() => {
    const m = new Map<number, Slot[]>();
    for (const s of view?.slots ?? []) m.set(s.weekday, [...(m.get(s.weekday) ?? []), s]);
    return m;
  }, [view]);

  async function saveSlot(e: React.FormEvent, force = false) {
    e.preventDefault?.();
    setError('');
    setNotice('');
    const days = editingId ? [Number(slotForm.weekday)] : slotForm.weekdays;
    if (!days.length) {
      setError('Pick at least one day.');
      return;
    }
    const body = {
      ...slotForm,
      campus: slotForm.campus || defaultCampus(gradeOptions),
      weekday: days[0],
      weekdays: editingId ? undefined : days,
      effectiveFrom: slotForm.effectiveFrom || null,
      effectiveTo: slotForm.effectiveTo || null,
      force,
    };
    const { ok, data } = await api<{ canForce?: boolean }>(
      editingId ? `/api/admin/timetable/slots/${editingId}` : '/api/admin/timetable/slots',
      { method: editingId ? 'PUT' : 'POST', body }
    );
    if (!ok) {
      if (data.canForce && confirm(`${data.error}\n\nSave anyway?`)) return saveSlot(e, true);
      setError(data.error || 'Could not save');
      return;
    }
    setNotice(editingId ? 'Slot updated.' : days.length > 1 ? `${days.length} weekly slots added (${days.map((d) => DAYS[d]).join(', ')}).` : 'Slot added.');
    setEditingId(null);
    setSlotForm({
      ...emptySlot,
      teacherId: slotForm.teacherId,
      campus: slotForm.campus,
      grade: slotForm.grade,
      divisions: slotForm.divisions,
      weekdays: slotForm.weekdays,
    });
    void load();
  }

  function editSlot(s: Slot) {
    setEditingId(s.id);
    setSlotForm({
      teacherId: s.teacherId,
      campus: s.campus,
      grade: s.grade,
      divisions: s.allDivisions ? 'ALL' : s.divisions.join(', '),
      subject: s.subject,
      weekday: s.weekday,
      weekdays: [s.weekday],
      start: s.start,
      end: s.end,
      effectiveFrom: s.effectiveFrom ?? '',
      effectiveTo: s.effectiveTo ?? '',
    });
    document.getElementById('slot-form')?.scrollIntoView({ behavior: 'smooth' });
  }

  async function removeSlot(s: Slot) {
    if (!confirm(`Delete ${s.subject} (${s.audience}) on ${DAYS[s.weekday]} ${s.start}? Past attendance is kept.`)) return;
    const { ok, data } = await api(`/api/admin/timetable/slots/${s.id}`, { method: 'DELETE' });
    if (!ok) setError(data.error || 'Delete failed');
    void load();
  }

  async function saveOverride(e: React.FormEvent, force = false) {
    e.preventDefault?.();
    setError('');
    setNotice('');
    const body = {
      kind: ov.kind,
      date: ov.date,
      slotId: ov.kind === 'EXTRA' ? null : ov.slotId || null,
      teacherId: ov.teacherId || null,
      campus: ov.kind === 'EXTRA' ? ov.campus || defaultCampus(gradeOptions) || null : null,
      grade: ov.grade || null,
      divisions: ov.divisions || null,
      subject: ov.subject || null,
      start: ov.start || null,
      end: ov.end || null,
      note: ov.note || null,
      force,
    };
    const { ok, data } = await api<{ canForce?: boolean }>('/api/admin/timetable/overrides', { body });
    if (!ok) {
      if (data.canForce && confirm(`${data.error}\n\nSave anyway?`)) return saveOverride(e, true);
      setError(data.error || 'Could not save');
      return;
    }
    setNotice('Change saved.');
    setOv({ ...ov, slotId: '', teacherId: '', campus: '', grade: '', divisions: '', subject: '', start: '', end: '', note: '' });
    void load();
  }

  async function removeOverride(o: Override) {
    if (!confirm('Remove this change? The regular timetable applies again.')) return;
    await api(`/api/admin/timetable/overrides/${o.id}`, { method: 'DELETE' });
    void load();
  }

  const teachers = all?.teachers ?? view?.teachers ?? [];
  const slotsForDate = (all?.slots ?? []).filter(
    (s) =>
      ov.date &&
      s.weekday === weekdayOfDate(ov.date) &&
      (!s.effectiveFrom || ov.date >= s.effectiveFrom) &&
      (!s.effectiveTo || ov.date <= s.effectiveTo)
  );

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm text-danger-fg" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-100">{notice}</p>}

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex rounded-xl border border-white/10 p-1">
            {(['teacher', 'grade'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn('rounded-lg px-3 py-1.5 text-sm font-medium', mode === m ? 'bg-brand-600 text-white' : 'text-slate-400 hover:text-white')}
              >
                {m === 'teacher' ? 'By teacher' : 'By grade-division'}
              </button>
            ))}
          </div>
          {mode === 'teacher' ? (
            <select className="input max-w-xs" value={teacherId} onChange={(e) => setTeacherId(e.target.value)} aria-label="Teacher">
              <option value="">Choose a teacher…</option>
              {teachers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.disabled ? ' (disabled)' : ''}
                </option>
              ))}
            </select>
          ) : (
            <>
              <CampusSelect className="w-40" value={campus} onChange={setCampus} options={gradeOptions} emptyLabel="All campuses" />
              <GradeSelect
                className="w-40"
                value={grade}
                onChange={(g) => {
                  setGrade(g);
                  setDivision('');
                }}
                options={gradeOptions}
                emptyLabel="Choose a grade…"
              />
              <DivisionSelect className="w-40" grade={grade} value={division} onChange={setDivision} options={gradeOptions} ariaLabel="Division (optional)" />
            </>
          )}
          <p className="text-xs text-slate-500">Times are in {view?.timezone ?? '…'}.</p>
        </div>

        {showGrid ? (
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-7">
            {DAY_ORDER.map((d) => (
              <div key={d} className="rounded-xl border border-white/5 bg-black/10 p-2">
                <p className="mb-2 px-1 text-2xs font-semibold uppercase tracking-wider text-slate-400">{DAYS[d]}</p>
                <div className="space-y-2">
                  {(byDay.get(d) ?? []).map((s) => (
                    <div key={s.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-2 text-xs">
                      <p className="font-mono text-brand-300">
                        {s.start}–{s.end}
                      </p>
                      <p className="mt-0.5 font-semibold text-white">{s.subject}</p>
                      <p className="text-slate-400">{mode === 'teacher' ? s.audience : `${s.audience} · ${s.teacherName}`}</p>
                      {(s.effectiveFrom || s.effectiveTo) && (
                        <p className="text-slate-500">
                          {s.effectiveFrom ?? '…'} → {s.effectiveTo ?? '…'}
                        </p>
                      )}
                      <div className="mt-1 flex gap-3">
                        <button type="button" className="text-brand-300 hover:underline" onClick={() => editSlot(s)}>
                          Edit
                        </button>
                        <button type="button" className="text-red-300 hover:underline" onClick={() => void removeSlot(s)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                  {!(byDay.get(d) ?? []).length && <p className="px-1 text-xs text-slate-600">—</p>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-5 text-sm text-slate-400">
            {mode === 'teacher' ? 'Choose a teacher to see their week.' : 'Choose a grade (and optionally a division) to see its week.'}
          </p>
        )}
      </Card>

      <Card id="slot-form">
        <CardHeader
          title={editingId ? 'Edit weekly slot' : 'Add weekly slot'}
          subtitle={
            editingId
              ? 'Repeats every week. Changing the day moves this slot.'
              : 'Repeats every week. Pick one or more days (one slot per day), and one division, several to combine them, or All divisions for the whole grade. Lists come from Campuses & grades.'
          }
        />
        <form onSubmit={(e) => void saveSlot(e)} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="label">Teacher</span>
            <select className="input" required value={slotForm.teacherId} onChange={(e) => setSlotForm({ ...slotForm, teacherId: e.target.value })}>
              <option value="">Choose…</option>
              {teachers.filter((t) => !t.disabled || t.id === slotForm.teacherId).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">Campus</span>
            <CampusSelect
              required
              value={slotForm.campus || defaultCampus(gradeOptions)}
              onChange={(c) => setSlotForm({ ...slotForm, campus: c })}
              options={gradeOptions}
            />
          </label>
          <label className="block">
            <span className="label">Grade</span>
            <GradeSelect
              required
              value={slotForm.grade}
              onChange={(g) => setSlotForm({ ...slotForm, grade: g, divisions: g === slotForm.grade ? slotForm.divisions : '' })}
              options={gradeOptions}
            />
          </label>
          <div className="block sm:col-span-2 lg:col-span-1">
            <span className="label">Divisions</span>
            <DivisionsPicker grade={slotForm.grade} value={slotForm.divisions} onChange={(d) => setSlotForm({ ...slotForm, divisions: d })} options={gradeOptions} />
          </div>
          <label className="block">
            <span className="label">Subject</span>
            <input className="input" required value={slotForm.subject} onChange={(e) => setSlotForm({ ...slotForm, subject: e.target.value })} placeholder="Mathematics" />
          </label>
          <div className="block sm:col-span-2">
            <span className="label">{editingId ? 'Day' : 'Days'}</span>
            <div className="flex min-h-[42px] flex-wrap items-center gap-1.5 rounded-xl border border-white/10 bg-black/20 p-1.5" role="group" aria-label="Days">
              {DAY_ORDER.map((d) => {
                const on = editingId ? slotForm.weekday === d : slotForm.weekdays.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    className={cn(
                      'day-chip rounded-lg border px-2.5 py-1 text-xs font-medium transition',
                      on ? 'border-brand-400/60 bg-brand-600 text-white' : 'border-white/10 text-slate-300 hover:border-white/30'
                    )}
                    onClick={() =>
                      editingId
                        ? setSlotForm({ ...slotForm, weekday: d, weekdays: [d] })
                        : setSlotForm({
                            ...slotForm,
                            weekdays: on ? slotForm.weekdays.filter((x) => x !== d) : [...slotForm.weekdays, d],
                          })
                    }
                  >
                    {DAYS[d]}
                  </button>
                );
              })}
              {!editingId && (
                <button
                  type="button"
                  className="ml-auto px-1 text-2xs text-slate-400 hover:text-white"
                  onClick={() => setSlotForm({ ...slotForm, weekdays: slotForm.weekdays.length >= 5 ? [] : [1, 2, 3, 4, 5] })}
                >
                  {slotForm.weekdays.length >= 5 ? 'Clear' : 'Mon–Fri'}
                </button>
              )}
            </div>
          </div>
          <label className="block">
            <span className="label">Start</span>
            <input className="input" type="time" required value={slotForm.start} onChange={(e) => setSlotForm({ ...slotForm, start: e.target.value })} />
          </label>
          <label className="block">
            <span className="label">End</span>
            <input className="input" type="time" required value={slotForm.end} onChange={(e) => setSlotForm({ ...slotForm, end: e.target.value })} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="label">From (optional)</span>
              <input className="input px-2" type="date" value={slotForm.effectiveFrom} onChange={(e) => setSlotForm({ ...slotForm, effectiveFrom: e.target.value })} />
            </label>
            <label className="block">
              <span className="label">To (optional)</span>
              <input className="input px-2" type="date" value={slotForm.effectiveTo} onChange={(e) => setSlotForm({ ...slotForm, effectiveTo: e.target.value })} />
            </label>
          </div>
          <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
            <Button type="submit">{editingId ? 'Save changes' : slotForm.weekdays.length > 1 ? `Add ${slotForm.weekdays.length} slots` : 'Add slot'}</Button>
            {editingId && (
              <Button
                variant="ghost"
                onClick={() => {
                  setEditingId(null);
                  setSlotForm(emptySlot);
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader
          title="One-off changes"
          subtitle="Cancel a class on a date, change its teacher (substitute), time or subject, or add an extra class."
        />
        <form onSubmit={(e) => void saveOverride(e)} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="label">Change</span>
            <select className="input" value={ov.kind} onChange={(e) => setOv({ ...ov, kind: e.target.value as Override['kind'] })}>
              <option value="CANCEL">Cancel a class</option>
              <option value="MODIFY">Substitute / change time</option>
              <option value="EXTRA">Extra one-off class</option>
            </select>
          </label>
          <label className="block">
            <span className="label">Date</span>
            <input className="input" type="date" required value={ov.date} onChange={(e) => setOv({ ...ov, date: e.target.value, slotId: '' })} />
          </label>
          {ov.kind !== 'EXTRA' && (
            <label className="block sm:col-span-2">
              <span className="label">Class on that date</span>
              <select className="input" required value={ov.slotId} onChange={(e) => setOv({ ...ov, slotId: e.target.value })}>
                <option value="">{slotsForDate.length ? 'Choose…' : 'No classes on that day'}</option>
                {slotsForDate.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.start}–{s.end} {s.subject} · {s.audience} · {s.teacherName}
                  </option>
                ))}
              </select>
            </label>
          )}
          {ov.kind !== 'CANCEL' && (
            <>
              <label className="block">
                <span className="label">{ov.kind === 'EXTRA' ? 'Teacher' : 'Substitute teacher (optional)'}</span>
                <select className="input" value={ov.teacherId} required={ov.kind === 'EXTRA'} onChange={(e) => setOv({ ...ov, teacherId: e.target.value })}>
                  <option value="">{ov.kind === 'EXTRA' ? 'Choose…' : 'Same teacher'}</option>
                  {teachers.filter((t) => !t.disabled).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="label">Start {ov.kind === 'MODIFY' && '(optional)'}</span>
                <input className="input" type="time" required={ov.kind === 'EXTRA'} value={ov.start} onChange={(e) => setOv({ ...ov, start: e.target.value })} />
              </label>
              <label className="block">
                <span className="label">End {ov.kind === 'MODIFY' && '(optional)'}</span>
                <input className="input" type="time" required={ov.kind === 'EXTRA'} value={ov.end} onChange={(e) => setOv({ ...ov, end: e.target.value })} />
              </label>
              <label className="block">
                <span className="label">Subject {ov.kind === 'MODIFY' && '(optional)'}</span>
                <input className="input" required={ov.kind === 'EXTRA'} value={ov.subject} onChange={(e) => setOv({ ...ov, subject: e.target.value })} />
              </label>
              {ov.kind === 'EXTRA' && (
                <>
                  <label className="block">
                    <span className="label">Campus</span>
                    <CampusSelect required value={ov.campus || defaultCampus(gradeOptions)} onChange={(c) => setOv({ ...ov, campus: c })} options={gradeOptions} />
                  </label>
                  <label className="block">
                    <span className="label">Grade</span>
                    <GradeSelect
                      required
                      value={ov.grade}
                      onChange={(g) => setOv({ ...ov, grade: g, divisions: g === ov.grade ? ov.divisions : '' })}
                      options={gradeOptions}
                    />
                  </label>
                  <div className="block sm:col-span-2 lg:col-span-1">
                    <span className="label">Divisions</span>
                    <DivisionsPicker grade={ov.grade} value={ov.divisions} onChange={(d) => setOv({ ...ov, divisions: d })} options={gradeOptions} />
                  </div>
                </>
              )}
            </>
          )}
          <label className="block sm:col-span-2">
            <span className="label">Note (optional)</span>
            <input className="input" value={ov.note} onChange={(e) => setOv({ ...ov, note: e.target.value })} maxLength={200} />
          </label>
          <div className="sm:col-span-2 lg:col-span-4">
            <Button type="submit">Save change</Button>
          </div>
        </form>

        <h3 className="mb-2 mt-8 text-sm font-semibold text-slate-300">Upcoming changes</h3>
        {!(all?.overrides ?? []).length ? (
          <p className="text-sm text-slate-500">None.</p>
        ) : (
          <ul className="divide-y divide-white/5 text-sm">
            {(all?.overrides ?? []).map((o) => (
              <li key={o.id} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <span className="mr-2 font-mono text-slate-300">{o.date}</span>
                  <Badge tone={o.kind === 'CANCEL' ? 'danger' : o.kind === 'EXTRA' ? 'success' : 'warning'}>
                    {o.kind === 'CANCEL' ? 'Cancelled' : o.kind === 'EXTRA' ? 'Extra' : 'Changed'}
                  </Badge>
                  <span className="ml-2 text-slate-300">
                    {o.slotLabel ?? `${o.subject} · ${o.audience}`}
                    {o.kind !== 'CANCEL' && o.teacherName ? ` → ${o.teacherName}` : ''}
                    {o.start ? ` · ${o.start}–${o.end ?? ''}` : ''}
                    {o.kind === 'MODIFY' && o.subject ? ` · ${o.subject}` : ''}
                  </span>
                  {o.note && <span className="ml-2 text-slate-500">({o.note})</span>}
                </div>
                <button type="button" className="self-start text-xs text-red-300 hover:underline" onClick={() => void removeOverride(o)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

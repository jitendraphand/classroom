'use client';

import { useCallback, useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { invalidateGradeOptions } from '@/components/admin/GradePickers';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { api } from '@/lib/clientFetch';
import { cn } from '@/lib/cn';
import { displayDivision } from '@/lib/grades';

type Division = { id: string; name: string; label: string; active: boolean; usageCount: number };
type Grade = { id: string; name: string; label: string; sortOrder: number; active: boolean; usageCount: number; divisions: Division[] };
type Unrecognised = { grade: string; division: string; count: number; gradeKnown: boolean };
type Data = { grades: Grade[]; unrecognised: Unrecognised[] };

export default function AdminGradesPage() {
  return (
    <AdminShell title="Grades & divisions">
      <GradesPanel />
    </AdminShell>
  );
}

function GradesPanel() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [newGrade, setNewGrade] = useState({ label: '', divisions: '' });

  const load = useCallback(async () => {
    const { ok, data: d } = await api<Data>('/api/admin/grades');
    if (ok) setData(d);
    else setError(d.error || 'Could not load grades');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run a change; on "in use" (409 + suggest deactivate) offer to deactivate instead. */
  async function run(path: string, opts: { method?: string; body?: unknown }, ok: string, deactivate?: () => Promise<unknown>) {
    setError('');
    setNotice('');
    setBusy(true);
    const r = await api<{ suggest?: string }>(path, opts);
    setBusy(false);
    if (!r.ok) {
      const msg = r.data.error || 'Something went wrong';
      if (r.data.suggest === 'deactivate' && deactivate && confirm(`${msg}\n\nDeactivate it now?`)) {
        await deactivate();
        return true;
      }
      setError(msg);
      return false;
    }
    invalidateGradeOptions();
    if (ok) setNotice(ok);
    void load();
    return true;
  }

  const patchGrade = (g: Grade, body: Record<string, unknown>, ok = 'Saved.') =>
    run(`/api/admin/grades/${g.id}`, { method: 'PATCH', body }, ok);
  const patchDivision = (d: Division, body: Record<string, unknown>, ok = 'Saved.') =>
    run(`/api/admin/divisions/${d.id}`, { method: 'PATCH', body }, ok);

  async function addGrade(e: React.FormEvent) {
    e.preventDefault();
    if (await run('/api/admin/grades', { body: newGrade }, `Grade ${newGrade.label} added.`)) setNewGrade({ label: '', divisions: '' });
  }

  async function move(index: number, dir: -1 | 1) {
    if (!data) return;
    const ids = data.grades.map((g) => g.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j]!, ids[index]!];
    await run('/api/admin/grades/reorder', { body: { ids } }, '');
  }

  async function recognise(u: Unrecognised) {
    await run('/api/admin/grades/recognise', { body: { grade: u.grade, division: u.division } }, `Added ${u.grade}-${displayDivision(u.division)}.`);
  }

  const grades = data?.grades ?? [];

  return (
    <div className="space-y-6">
      {error && (
        <p className="whitespace-pre-line rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm text-danger-fg" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-100">{notice}</p>}

      {!!data?.unrecognised.length && (
        <Card className="border-amber-400/30">
          <CardHeader
            title="Unrecognised grade/divisions seen from the school app"
            subtitle="Students joined with these, so they were saved but no class can be scheduled for them until the entry exists here. Add the ones that are real; ignore typos (fix them in the school app)."
          />
          <ul className="divide-y divide-white/5 text-sm">
            {data.unrecognised.map((u) => (
              <li key={`${u.grade}|${u.division}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium text-white">
                    {u.grade}-{displayDivision(u.division)}
                  </span>{' '}
                  <span className="text-slate-400">
                    · {u.count} student{u.count === 1 ? '' : 's'}
                    {u.gradeKnown ? '' : ' · new grade'}
                  </span>
                </span>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void recognise(u)}>
                  Add {u.gradeKnown ? 'division' : 'grade + division'}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Add grade"
          subtitle="Grades and divisions here fill every grade/division dropdown (timetable, teachers, reports, students, ad-hoc classes). Case and spaces do not matter: 'mahaveer' and 'Mahaveer' are the same division."
        />
        <form onSubmit={addGrade} className="grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
          <label className="block">
            <span className="label">Grade</span>
            <input className="input" required maxLength={32} value={newGrade.label} onChange={(e) => setNewGrade({ ...newGrade, label: e.target.value })} placeholder="7, KG, XII" />
          </label>
          <label className="block">
            <span className="label">Divisions (optional)</span>
            <input className="input" value={newGrade.divisions} onChange={(e) => setNewGrade({ ...newGrade, divisions: e.target.value })} placeholder="A, B, C or Mahaveer, Shivaji" />
          </label>
          <Button type="submit" disabled={busy}>
            Add grade
          </Button>
        </form>
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-white/5 pt-4 text-xs text-slate-400">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run('/api/admin/grades/sync', { method: 'POST' }, 'Synced from existing data.')}>
            Sync from existing data
          </Button>
          Adds any grade/division already used by teachers, the timetable, students or past classes.
        </div>
      </Card>

      <Card padding={false}>
        <div className="p-5 sm:p-6">
          <h2 className="font-display text-lg font-semibold">Grades {data ? `(${grades.length})` : ''}</h2>
          <p className="mt-1 text-xs text-slate-500">
            Deactivated entries disappear from dropdowns but existing classes, students and reports keep them. Entries that are in use cannot be deleted or have their name changed (the display label can always change).
          </p>
        </div>
        {!data ? (
          <p className="px-6 pb-6 text-sm text-slate-400">Loading…</p>
        ) : !grades.length ? (
          <p className="px-6 pb-6 text-sm text-slate-400">No grades yet. Add one above, or sync from existing data. Until then grade/division fields accept free text.</p>
        ) : (
          <ul className="divide-y divide-white/5">
            {grades.map((g, i) => (
              <GradeRow
                key={g.id}
                g={g}
                first={i === 0}
                last={i === grades.length - 1}
                busy={busy}
                onMove={(dir) => void move(i, dir)}
                onRename={(label) => patchGrade(g, { label }, 'Grade renamed.')}
                onToggle={() => void patchGrade(g, { active: !g.active }, g.active ? `Grade ${g.name} deactivated.` : `Grade ${g.name} activated.`)}
                onDelete={() => {
                  if (!confirm(`Delete grade ${g.label}${g.divisions.length ? ` and its ${g.divisions.length} division(s)` : ''}?`)) return;
                  void run(`/api/admin/grades/${g.id}`, { method: 'DELETE' }, `Grade ${g.name} deleted.`, () =>
                    patchGrade(g, { active: false }, `Grade ${g.name} deactivated.`)
                  );
                }}
                onAddDivision={(name) => run(`/api/admin/grades/${g.id}/divisions`, { body: { name } }, 'Division added.')}
                onRenameDivision={(d, label) => patchDivision(d, { label }, 'Division renamed.')}
                onToggleDivision={(d) => void patchDivision(d, { active: !d.active }, d.active ? 'Division deactivated.' : 'Division activated.')}
                onDeleteDivision={(d) => {
                  if (!confirm(`Delete division ${g.name}-${d.label}?`)) return;
                  void run(`/api/admin/divisions/${d.id}`, { method: 'DELETE' }, 'Division deleted.', () =>
                    patchDivision(d, { active: false }, 'Division deactivated.')
                  );
                }}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function GradeRow(props: {
  g: Grade;
  first: boolean;
  last: boolean;
  busy: boolean;
  onMove: (dir: -1 | 1) => void;
  onRename: (label: string) => Promise<boolean>;
  onToggle: () => void;
  onDelete: () => void;
  onAddDivision: (name: string) => Promise<boolean>;
  onRenameDivision: (d: Division, label: string) => Promise<boolean>;
  onToggleDivision: (d: Division) => void;
  onDeleteDivision: (d: Division) => void;
}) {
  const { g, busy } = props;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newDiv, setNewDiv] = useState('');
  const [divEdit, setDivEdit] = useState<{ id: string; label: string } | null>(null);

  return (
    <li className={cn('px-5 py-4 sm:px-6', !g.active && 'opacity-60')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex flex-col">
            <button type="button" className="text-xs text-slate-400 hover:text-white disabled:opacity-30" disabled={props.first || busy} onClick={() => props.onMove(-1)} aria-label={`Move ${g.label} up`}>
              ▲
            </button>
            <button type="button" className="text-xs text-slate-400 hover:text-white disabled:opacity-30" disabled={props.last || busy} onClick={() => props.onMove(1)} aria-label={`Move ${g.label} down`}>
              ▼
            </button>
          </div>
          {renaming !== null ? (
            <form
              className="flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (await props.onRename(renaming)) setRenaming(null);
              }}
            >
              <input className="input w-40" value={renaming} maxLength={32} onChange={(e) => setRenaming(e.target.value)} aria-label="Grade label" autoFocus />
              <Button type="submit" size="sm">
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
            </form>
          ) : (
            <p className="font-display text-lg font-semibold text-white">
              {g.label}
              {g.label !== g.name && <span className="ml-2 text-xs font-normal text-slate-500">({g.name})</span>}
            </p>
          )}
          {!g.active && <Badge tone="warning">Inactive</Badge>}
          <span className="text-xs text-slate-500">{g.usageCount ? `${g.usageCount} in use` : 'not used'}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => setRenaming(g.label)}>
            Rename
          </Button>
          <Button size="sm" variant={g.active ? 'warning' : 'secondary'} disabled={busy} onClick={props.onToggle}>
            {g.active ? 'Deactivate' : 'Activate'}
          </Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={props.onDelete}>
            Delete
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 pl-6">
        {g.divisions.map((d) =>
          divEdit?.id === d.id ? (
            <form
              key={d.id}
              className="flex gap-1"
              onSubmit={async (e) => {
                e.preventDefault();
                if (await props.onRenameDivision(d, divEdit.label)) setDivEdit(null);
              }}
            >
              <input className="input w-32 py-1 text-xs" value={divEdit.label} maxLength={32} onChange={(e) => setDivEdit({ id: d.id, label: e.target.value })} aria-label="Division label" autoFocus />
              <Button type="submit" size="sm">
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDivEdit(null)}>
                ×
              </Button>
            </form>
          ) : (
            <span
              key={d.id}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs',
                d.active ? 'border-white/15 text-slate-200' : 'border-amber-400/30 text-amber-200/80 line-through decoration-amber-400/40'
              )}
              title={`${d.name} · ${d.usageCount ? `${d.usageCount} in use` : 'not used'}${d.active ? '' : ' · inactive'}`}
            >
              {d.label}
              {d.usageCount > 0 && <span className="text-slate-500">·{d.usageCount}</span>}
              <button type="button" className="text-slate-400 hover:text-white" onClick={() => setDivEdit({ id: d.id, label: d.label })} aria-label={`Rename ${d.label}`}>
                ✎
              </button>
              <button type="button" className="text-slate-400 hover:text-amber-200" onClick={() => props.onToggleDivision(d)} aria-label={`${d.active ? 'Deactivate' : 'Activate'} ${d.label}`} title={d.active ? 'Deactivate' : 'Activate'}>
                {d.active ? '⏸' : '▶'}
              </button>
              <button type="button" className="text-slate-400 hover:text-red-300" onClick={() => props.onDeleteDivision(d)} aria-label={`Delete ${d.label}`} title="Delete">
                ×
              </button>
            </span>
          )
        )}
        {!g.divisions.length && <span className="text-xs text-slate-500">No divisions yet.</span>}
        <form
          className="flex gap-1"
          onSubmit={async (e) => {
            e.preventDefault();
            if (newDiv.trim() && (await props.onAddDivision(newDiv))) setNewDiv('');
          }}
        >
          <input className="input w-36 py-1 text-xs" value={newDiv} onChange={(e) => setNewDiv(e.target.value)} placeholder="Add division(s)" aria-label={`Add division to grade ${g.label}`} />
          <Button type="submit" size="sm" variant="secondary" disabled={busy || !newDiv.trim()}>
            Add
          </Button>
        </form>
      </div>
    </li>
  );
}

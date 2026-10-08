'use client';

import { useCallback, useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { CampusSelect, DivisionSelect, GradeSelect, invalidateGradeOptions, useGradeOptions } from '@/components/admin/GradePickers';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { api } from '@/lib/clientFetch';
import { displayDivision, normalizeDivision, normalizeGrade } from '@/lib/grades';

type Unrecognised = { grade: string; division: string; count: number; gradeKnown: boolean };

type Student = {
  id: string;
  externalId: string;
  name: string;
  campus: string;
  grade: string;
  division: string;
  rollNumber: string | null;
  source: string;
  lastSeenAt: string | null;
};

export default function AdminStudentsPage() {
  return (
    <AdminShell title="Students">
      <StudentsPanel />
    </AdminShell>
  );
}

function StudentsPanel() {
  const [filter, setFilter] = useState({ campus: '', grade: '', division: '', q: '' });
  const [data, setData] = useState<{
    total: number;
    students: Student[];
    groups: { campus: string; grade: string; division: string; count: number }[];
  } | null>(null);
  const [importCampus, setImportCampus] = useState('');
  const [deleting, setDeleting] = useState<Student | null>(null);
  const [unknownCampuses, setUnknownCampuses] = useState<{ campus: string; count: number }[]>([]);
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<string>('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const gradeOptions = useGradeOptions();
  // Grade/divisions students joined with that Grades & divisions does not know.
  const [unrecognised, setUnrecognised] = useState<Unrecognised[]>([]);
  const [notice, setNotice] = useState('');

  const loadUnrecognised = useCallback(async () => {
    const [r, c] = await Promise.all([
      api<{ unrecognised: Unrecognised[] }>('/api/admin/grades'),
      api<{ unrecognised: { campus: string; count: number }[] }>('/api/admin/campuses'),
    ]);
    if (r.ok) setUnrecognised(r.data.unrecognised ?? []);
    if (c.ok) setUnknownCampuses(c.data.unrecognised ?? []);
  }, []);

  useEffect(() => {
    void loadUnrecognised();
  }, [loadUnrecognised]);

  const unknownKeys = new Set(unrecognised.map((u) => `${u.grade}|${u.division}`));
  const unknownCampusSet = new Set(unknownCampuses.map((u) => u.campus));
  const isUnknown = (s: Student) =>
    unknownKeys.has(`${normalizeGrade(s.grade)}|${normalizeDivision(s.division)}`) || unknownCampusSet.has(s.campus);

  async function recogniseCampus(campus: string) {
    setBusy(true);
    setNotice('');
    const r = await api('/api/admin/campuses', { body: { label: campus } });
    setBusy(false);
    setNotice(r.ok ? `Added campus ${campus}.` : r.data.error || 'Could not add it.');
    invalidateGradeOptions();
    gradeOptions.reload();
    void loadUnrecognised();
  }

  async function removeStudent(s: Student) {
    const r = await api<{ ok: boolean }>('/api/admin/students', { method: 'DELETE', body: { id: s.id } });
    if (!r.ok) {
      setNotice(r.data.error || 'Delete failed');
      return;
    }
    setNotice(`Deleted ${s.name} (${s.externalId}). Their attendance history stays in reports.`);
    setDeleting(null);
    void load();
  }

  async function recognise(u: Unrecognised) {
    setBusy(true);
    setNotice('');
    const r = await api('/api/admin/grades/recognise', { body: { grade: u.grade, division: u.division } });
    setBusy(false);
    setNotice(r.ok ? `Added ${u.grade}-${displayDivision(u.division)} to Grades & divisions.` : r.data.error || 'Could not add it.');
    void loadUnrecognised();
  }

  const load = useCallback(async () => {
    const p = new URLSearchParams(Object.entries(filter).filter(([, v]) => v));
    const r = await api<NonNullable<typeof data>>(`/api/admin/students?${p}`);
    if (r.ok) setData(r.data);
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runImport(dryRun: boolean) {
    setBusy(true);
    setResult('');
    const { ok, data: d } = await api<{ created?: number; updated?: number; valid?: number; errors: string[]; errorCount: number }>(
      '/api/admin/students/import',
      { body: { csv, dryRun, ...(importCampus ? { campus: importCampus } : {}) } }
    );
    setBusy(false);
    if (!ok) {
      setResult(d.error || 'Import failed');
      return;
    }
    setErrors(d.errors ?? []);
    setResult(
      dryRun
        ? `${d.valid} valid rows, ${d.errorCount} problem(s). Nothing saved yet.`
        : `Imported: ${d.created} new, ${d.updated} updated, ${d.errorCount} skipped.`
    );
    if (!dryRun) void load();
  }

  return (
    <div className="space-y-6">
      {notice && (
        <p className="rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-100" role="status">
          {notice}
        </p>
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          confirmLabel="Delete student"
          onConfirm={() => removeStudent(deleting)}
          onClose={() => setDeleting(null)}
        >
          <p>
            {deleting.name} ({deleting.externalId}, {deleting.campus} · {deleting.grade}-{displayDivision(deleting.division)}) is removed from the
            student list and new reports, and leaves any class they are in now.
          </p>
          <p className="text-slate-400">
            Past attendance stays in reports. If the student opens a join link from the school app again (or is in a roster import), they come back
            with their history.
          </p>
        </ConfirmDialog>
      )}
      {unknownCampuses.length > 0 && (
        <Card className="border-amber-400/40">
          <CardHeader
            title="Students with an unrecognised campus"
            subtitle="These came from the school app with a campus that is not in Grades & divisions → Campuses. Add the real ones; fix typos in the school app."
          />
          <ul className="divide-y divide-white/5 text-sm" aria-label="Unrecognised campuses">
            {unknownCampuses.map((u) => (
              <li key={u.campus} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium text-amber-100">{u.campus}</span>{' '}
                  <span className="text-slate-400">
                    · {u.count} student{u.count === 1 ? '' : 's'}
                  </span>
                </span>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void recogniseCampus(u.campus)}>
                  Add campus
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {unrecognised.length > 0 && (
        <Card className="border-amber-400/40">
          <CardHeader
            title="Students with an unrecognised grade or division"
            subtitle="These came from the school app but are not in Grades & divisions, so no class can be scheduled for them (they are told so when they open the class). Add the real ones; fix typos in the school app."
          />
          <ul className="divide-y divide-white/5 text-sm" aria-label="Unrecognised grade/divisions">
            {unrecognised.map((u) => (
              <li key={`${u.grade}|${u.division}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium text-amber-100">
                    {u.grade}-{displayDivision(u.division)}
                  </span>{' '}
                  <span className="text-slate-400">
                    · {u.count} student{u.count === 1 ? '' : 's'}
                    {u.gradeKnown ? ' · unknown division' : ' · unknown grade'}
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
          title="Import roster (optional)"
          subtitle="Students appear here automatically the first time they join from the school app. Import the roster so students who never join are counted as absent."
        />
        <p className="mb-2 text-xs text-slate-400">
          CSV columns: <code className="text-slate-200">externalId,name,grade,division,roll,campus</code> (header row optional). The
          externalId must be the same student ID the school app sends. Rows without a campus use the campus picked below. Campus, grade
          and division must be active entries in{' '}
          <a href="/admin/grades" className="text-brand-300 hover:underline">
            Grades &amp; divisions
          </a>{' '}
          (case and spaces do not matter); other rows are reported and skipped.
        </p>
        <label className="mb-3 flex flex-wrap items-center gap-2 text-sm text-slate-300">
          Campus for rows without one
          <CampusSelect className="w-44" value={importCampus} onChange={setImportCampus} options={gradeOptions} emptyLabel="Only campus / none" />
        </label>
        <input
          type="file"
          accept=".csv,text/csv"
          className="mb-3 block text-sm text-slate-300"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setCsv(await f.text());
          }}
        />
        <textarea
          className="input h-32 font-mono text-xs"
          placeholder={'externalId,name,grade,division,roll,campus\nS1001,Asha Patil,7,A,1,CC'}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          aria-label="Roster CSV"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" disabled={!csv || busy} onClick={() => void runImport(true)}>
            Check
          </Button>
          <Button disabled={!csv || busy} onClick={() => void runImport(false)}>
            {busy ? 'Working…' : 'Import'}
          </Button>
        </div>
        {result && <p className="mt-3 text-sm text-slate-200">{result}</p>}
        {errors.length > 0 && (
          <ul className="mt-2 max-h-32 overflow-y-auto text-xs text-amber-200">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
      </Card>

      <Card padding={false}>
        <div className="flex flex-wrap items-end gap-3 p-5 sm:p-6">
          <CampusSelect className="w-40" value={filter.campus} onChange={(c) => setFilter({ ...filter, campus: c })} options={gradeOptions} emptyLabel="All campuses" />
          <GradeSelect className="w-40" value={filter.grade} onChange={(g) => setFilter({ ...filter, grade: g, division: '' })} options={gradeOptions} emptyLabel="All grades" />
          <DivisionSelect className="w-40" grade={filter.grade} value={filter.division} onChange={(d) => setFilter({ ...filter, division: d })} options={gradeOptions} />
          <input className="input max-w-xs" placeholder="Name, ID or roll no" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} aria-label="Search" />
          <p className="text-sm text-slate-400">{data ? `${data.total} student(s)` : ''}</p>
        </div>
        {data && data.groups.length > 0 && (
          <p className="px-6 pb-3 text-xs text-slate-500">
            {data.groups.map((g) => `${g.campus} ${g.grade}-${displayDivision(g.division)}: ${g.count}`).join(' · ')}
          </p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="text-2xs uppercase tracking-wider text-slate-500">
              <tr className="border-b border-white/5">
                {['Student ID', 'Name', 'Campus', 'Class', 'Roll', 'Source', 'Last joined', ''].map((h) => (
                  <th key={h} className="px-4 py-3 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {(data?.students ?? []).map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-2 font-mono text-xs">{s.externalId}</td>
                  <td className="px-4 py-2 text-white">{s.name}</td>
                  <td className="px-4 py-2">{s.campus}</td>
                  <td className="px-4 py-2">
                    {s.grade}-{displayDivision(s.division)}
                    {isUnknown(s) && (
                      <span
                        className="ml-2 rounded-md border border-amber-400/40 bg-amber-500/10 px-1.5 py-0.5 text-2xs font-semibold text-amber-200"
                        title="Campus, grade or division not in Grades & divisions: no class can be scheduled for this student"
                      >
                        Unrecognised
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">{s.rollNumber}</td>
                  <td className="px-4 py-2 text-slate-400">{s.source === 'import' ? 'Roster import' : 'School app'}</td>
                  <td className="px-4 py-2 text-xs text-slate-400">{s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : 'Never'}</td>
                  <td className="px-4 py-2 text-right">
                    <Button size="sm" variant="danger" onClick={() => setDeleting(s)} aria-label={`Delete ${s.name}`}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && data.total > data.students.length && (
          <p className="p-4 text-xs text-slate-500">Showing the first {data.students.length}; narrow the filter to see more.</p>
        )}
      </Card>
    </div>
  );
}

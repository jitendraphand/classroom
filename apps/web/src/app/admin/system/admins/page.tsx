'use client';

import { useEffect, useState } from 'react';
import { AdminShell, SecretOnce } from '@/components/admin/AdminShell';
import { Button } from '@/components/ui/Button';
import { useConfirm } from '@/components/ui/ConfirmDialog';
import { Card, CardHeader } from '@/components/ui/Card';
import { api } from '@/lib/clientFetch';
import { PRIVILEGE_LABELS, type Privilege, type PrivilegeSet } from '@/lib/privileges';

type AdminRow = { id: string; email: string; name: string; kind: 'SYSTEM' | 'SUB'; privileges: PrivilegeSet; teacherId: string | null };
type TeacherOpt = { id: string; name: string; email: string; disabled?: boolean };

const KEYS = Object.keys(PRIVILEGE_LABELS) as Privilege[];

function blank(): PrivilegeSet {
  return { manageTeachers: false, schedule: false, monitorLive: false, viewReports: false, manageSchool: false };
}

export default function SubAdminsPage() {
  return (
    <AdminShell title="Sub-administrators">
      <Editor />
    </AdminShell>
  );
}

function Editor() {
  const [rows, setRows] = useState<AdminRow[] | null>(null);
  const [error, setError] = useState('');
  // Item 11: a failed load (e.g. 403 for a sub-admin) shows only the message, not the form too.
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState({ name: '', email: '', privileges: blank() });
  const [notice, setNotice] = useState('');
  const [confirm, confirmDialog] = useConfirm();
  // Item 6: a sub-admin can be a new account or an existing teacher (one login, switchable views).
  const [source, setSource] = useState<'teacher' | 'new'>('teacher');
  const [teacherId, setTeacherId] = useState('');
  const [teachers, setTeachers] = useState<TeacherOpt[]>([]);
  const [secret, setSecret] = useState<{ title: string; lines: [string, string][] } | null>(null);

  async function load() {
    const { ok, data } = await api<{ admins: AdminRow[] }>('/api/admin/sub-admins');
    if (!ok) setLoadError(data.error || 'Could not load administrators');
    else {
      setLoadError('');
      setRows(data.admins);
    }
  }
  useEffect(() => {
    void load();
    void api<{ teachers: TeacherOpt[] }>('/api/admin/teachers').then(({ ok, data }) => {
      if (ok) setTeachers((data.teachers ?? []).filter((t) => !t.disabled));
    });
  }, []);

  function toggle(key: Privilege) {
    setForm((f) => ({ ...f, privileges: { ...f.privileges, [key]: !f.privileges[key] } }));
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (source === 'teacher') {
      if (!teacherId) {
        setError('Pick a teacher');
        return;
      }
      const r = await api<{ admin: AdminRow }>('/api/admin/sub-admins', { method: 'POST', body: { teacherId, privileges: form.privileges } });
      if (!r.ok) {
        setError(r.data.error || 'Could not create');
        return;
      }
      setTeacherId('');
      setForm({ name: '', email: '', privileges: blank() });
      void load();
      return;
    }
    const { ok, data } = await api<{ admin: AdminRow; temporaryPassword: string }>('/api/admin/sub-admins', {
      method: 'POST',
      body: { name: form.name, email: form.email, privileges: form.privileges },
    });
    if (!ok) {
      setError(data.error || 'Could not create');
      return;
    }
    setSecret({ title: 'Sub-administrator created', lines: [['Email', data.admin.email], ['Temporary password', data.temporaryPassword]] });
    setForm({ name: '', email: '', privileges: blank() });
    void load();
  }

  async function savePriv(row: AdminRow, privileges: PrivilegeSet) {
    setNotice('');
    const { ok, data } = await api(`/api/admin/sub-admins/${row.id}`, { method: 'PATCH', body: { privileges } });
    if (!ok) setError(data.error || 'Could not save');
    else {
      setNotice(`Saved permissions for ${row.name || row.email}. They apply at their next page load.`);
      void load();
    }
  }

  async function reset(row: AdminRow) {
    const go = await confirm({
      title: `Reset the password for ${row.name || row.email}?`,
      body: 'They are signed out and get a new temporary password, shown to you once.',
      confirmLabel: 'Reset password',
      tone: 'primary',
    });
    if (!go) return;
    const { ok, data } = await api<{ temporaryPassword?: string }>(`/api/admin/sub-admins/${row.id}`, { method: 'PATCH', body: { resetPassword: true } });
    if (!ok || !data.temporaryPassword) setError(data.error || 'Could not reset');
    else setSecret({ title: 'Password reset', lines: [['Email', row.email], ['Temporary password', data.temporaryPassword]] });
  }

  async function remove(row: AdminRow) {
    const msg = row.teacherId
      ? `Remove the admin role from ${row.name}? Their teacher account stays.`
      : `Delete ${row.email}?`;
    if (!(await confirm({ title: msg, confirmLabel: row.teacherId ? 'Remove admin role' : 'Delete' }))) return;
    const { ok, data } = await api(`/api/admin/sub-admins/${row.id}`, { method: 'DELETE' });
    if (!ok) setError(data.error || 'Could not delete');
    else void load();
  }

  if (loadError) {
    return (
      <p className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm text-danger-fg" role="alert">
        {loadError}
      </p>
    );
  }
  if (!rows) return <p className="text-sm text-slate-400">Loading…</p>;

  return (
    <div className="space-y-4">
      {confirmDialog}
      {secret && <SecretOnce title={secret.title} lines={secret.lines} onClose={() => setSecret(null)} />}
      {notice && (
        <p className="rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-100" role="status">
          {notice}
        </p>
      )}
      {error && <p className="text-sm text-red-300">{error}</p>}
      <Card>
        <CardHeader title="New sub-administrator" subtitle="Pick the privileges. The system administrator keeps every privilege." />
        <form className="space-y-3" onSubmit={(e) => void create(e)}>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" checked={source === 'teacher'} onChange={() => setSource('teacher')} /> Existing teacher
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={source === 'new'} onChange={() => setSource('new')} /> New account
            </label>
          </div>
          {source === 'teacher' ? (
            <label className="block">
              <span className="label">Teacher</span>
              <select className="input" value={teacherId} onChange={(e) => setTeacherId(e.target.value)} required>
                <option value="">Choose a teacher…</option>
                {teachers
                  .filter((t) => !(rows ?? []).some((r) => r.teacherId === t.id))
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} · {t.email}
                    </option>
                  ))}
              </select>
              <span className="mt-1 block text-xs text-slate-400">
                They keep one login (their teacher email and password) and switch between the teacher and admin views.
              </span>
            </label>
          ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="label">Name</span>
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </label>
            <label className="block">
              <span className="label">Email</span>
              <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            </label>
          </div>
          )}
          <PrivChecks value={form.privileges} onToggle={toggle} />
          <Button type="submit">Create sub-administrator</Button>
        </form>
      </Card>
      <Card>
        <CardHeader title="Accounts" />
        <ul className="divide-y divide-white/5">
          {(rows ?? []).map((row) => (
            <li key={row.id} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{row.name}</p>
                  <p className="text-sm text-slate-400">
                    {row.email} · {row.kind === 'SYSTEM' ? 'System administrator' : row.teacherId ? 'Teacher + sub-administrator' : 'Sub-administrator'}
                  </p>
                </div>
                {row.kind === 'SUB' && (
                  <div className="flex gap-2">
                    {!row.teacherId && (
                      <Button size="sm" variant="secondary" onClick={() => void reset(row)}>
                        Reset password
                      </Button>
                    )}
                    <Button size="sm" variant="dangerSoft" onClick={() => void remove(row)}>
                      {row.teacherId ? 'Remove admin role' : 'Delete'}
                    </Button>
                  </div>
                )}
              </div>
              {row.kind === 'SUB' && (
                <div className="mt-2">
                  <PrivChecks
                    value={row.privileges}
                    onToggle={(key) => void savePriv(row, { ...row.privileges, [key]: !row.privileges[key] })}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function PrivChecks({ value, onToggle }: { value: PrivilegeSet; onToggle: (key: Privilege) => void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {KEYS.map((key) => (
        <label key={key} className="flex items-start gap-2 text-sm text-slate-200">
          <input type="checkbox" className="mt-1" checked={value[key]} onChange={() => onToggle(key)} />
          <span>{PRIVILEGE_LABELS[key]}</span>
        </label>
      ))}
    </div>
  );
}

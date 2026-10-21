'use client';

import { useEffect, useState } from 'react';
import { AdminShell, SecretOnce } from '@/components/admin/AdminShell';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { api } from '@/lib/clientFetch';
import { PRIVILEGE_LABELS, type Privilege, type PrivilegeSet } from '@/lib/privileges';

type AdminRow = { id: string; email: string; name: string; kind: 'SYSTEM' | 'SUB'; privileges: PrivilegeSet };

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
  const [form, setForm] = useState({ name: '', email: '', privileges: blank() });
  const [secret, setSecret] = useState<{ title: string; lines: [string, string][] } | null>(null);

  async function load() {
    const { ok, data } = await api<{ admins: AdminRow[] }>('/api/admin/sub-admins');
    if (!ok) setError(data.error || 'Could not load administrators');
    else setRows(data.admins);
  }
  useEffect(() => {
    void load();
  }, []);

  function toggle(key: Privilege) {
    setForm((f) => ({ ...f, privileges: { ...f.privileges, [key]: !f.privileges[key] } }));
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const { ok, data } = await api<{ admin: AdminRow; temporaryPassword: string }>('/api/admin/sub-admins', { method: 'POST', body: form });
    if (!ok) {
      setError(data.error || 'Could not create');
      return;
    }
    setSecret({ title: 'Sub-administrator created', lines: [['Email', data.admin.email], ['Temporary password', data.temporaryPassword]] });
    setForm({ name: '', email: '', privileges: blank() });
    void load();
  }

  async function savePriv(row: AdminRow, privileges: PrivilegeSet) {
    const { ok, data } = await api(`/api/admin/sub-admins/${row.id}`, { method: 'PATCH', body: { privileges } });
    if (!ok) setError(data.error || 'Could not save');
    else void load();
  }

  async function reset(row: AdminRow) {
    const { ok, data } = await api<{ temporaryPassword?: string }>(`/api/admin/sub-admins/${row.id}`, { method: 'PATCH', body: { resetPassword: true } });
    if (!ok || !data.temporaryPassword) setError(data.error || 'Could not reset');
    else setSecret({ title: 'Password reset', lines: [['Email', row.email], ['Temporary password', data.temporaryPassword]] });
  }

  async function remove(row: AdminRow) {
    if (!confirm(`Delete ${row.email}?`)) return;
    const { ok, data } = await api(`/api/admin/sub-admins/${row.id}`, { method: 'DELETE' });
    if (!ok) setError(data.error || 'Could not delete');
    else void load();
  }

  return (
    <div className="space-y-4">
      {secret && <SecretOnce title={secret.title} lines={secret.lines} onClose={() => setSecret(null)} />}
      {error && <p className="text-sm text-red-300">{error}</p>}
      <Card>
        <CardHeader title="New sub-administrator" subtitle="Pick the privileges. The system administrator keeps every privilege." />
        <form className="space-y-3" onSubmit={(e) => void create(e)}>
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
                    {row.email} · {row.kind === 'SYSTEM' ? 'System administrator' : 'Sub-administrator'}
                  </p>
                </div>
                {row.kind === 'SUB' && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => void reset(row)}>
                      Reset password
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => void remove(row)}>
                      Delete
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

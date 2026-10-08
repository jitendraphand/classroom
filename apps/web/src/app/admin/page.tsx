'use client';

import { useCallback, useEffect, useState } from 'react';
import { AdminShell, SecretOnce } from '@/components/admin/AdminShell';
import { AssignmentsPicker, useGradeOptions } from '@/components/admin/GradePickers';
import { LiveNowBanner } from '@/components/admin/LiveNowBanner';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { api } from '@/lib/clientFetch';

type Teacher = {
  id: string;
  name: string;
  email: string;
  disabled: boolean;
  mustChangePassword: boolean;
  permanentCode: string;
  assignmentsText: string;
};

export default function AdminTeachersPage() {
  return (
    <AdminShell title="Teachers">
      <TeachersPanel />
    </AdminShell>
  );
}

function TeachersPanel() {
  const [teachers, setTeachers] = useState<Teacher[] | null>(null);
  const [error, setError] = useState('');
  const [secret, setSecret] = useState<{ title: string; lines: [string, string][] } | null>(null);
  const [form, setForm] = useState({ name: '', email: '', assignments: '' });
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: '', assignments: '' });
  const [filter, setFilter] = useState('');
  const gradeOptions = useGradeOptions();
  const [deleting, setDeleting] = useState<Teacher | null>(null);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ teachers: Teacher[] }>('/api/admin/teachers');
    if (ok) setTeachers(data.teachers);
    else setError(data.error || 'Could not load teachers');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { ok, data } = await api<{ teacher: Teacher; temporaryPassword: string }>('/api/admin/teachers', {
      body: form,
    });
    setBusy(false);
    if (!ok) {
      setError(data.error || 'Could not create teacher');
      return;
    }
    setSecret({
      title: `Teacher created: ${data.teacher.name}`,
      lines: [
        ['Email', data.teacher.email],
        ['Meeting code', data.teacher.permanentCode],
        ['Temporary password', data.temporaryPassword],
      ],
    });
    setForm({ name: '', email: '', assignments: '' });
    void load();
  }

  async function patch(id: string, body: Record<string, unknown>) {
    setError('');
    const { ok, data } = await api(`/api/admin/teachers/${id}`, { method: 'PATCH', body });
    if (!ok) {
      setError(data.error || 'Update failed');
      return false;
    }
    void load();
    return true;
  }

  async function resetPassword(t: Teacher) {
    if (!confirm(`Reset the password for ${t.name}? Their current sessions end immediately.`)) return;
    const { ok, data } = await api<{ temporaryPassword: string }>(`/api/admin/teachers/${t.id}/reset-password`, {
      method: 'POST',
    });
    if (!ok) {
      setError(data.error || 'Reset failed');
      return;
    }
    setSecret({
      title: `Password reset for ${t.name}`,
      lines: [
        ['Email', t.email],
        ['Temporary password', data.temporaryPassword],
      ],
    });
    void load();
  }

  async function remove(t: Teacher) {
    setError('');
    const { ok, data } = await api(`/api/admin/teachers/${t.id}`, { method: 'DELETE' });
    if (!ok) {
      setError(data.error || 'Delete failed');
      return;
    }
    setDeleting(null);
    void load();
  }

  const shown = (teachers ?? []).filter((t) =>
    !filter ? true : `${t.name} ${t.email} ${t.assignmentsText}`.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <LiveNowBanner />
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          confirmLabel="Delete teacher"
          typeToConfirm={deleting.name}
          onConfirm={() => remove(deleting)}
          onClose={() => setDeleting(null)}
        >
          <p>
            {deleting.name} ({deleting.email}) is signed out, any class they are running ends, and their timetable slots, grade assignments
            and meeting code stop working. This cannot be undone.
          </p>
          <p className="text-slate-400">
            Past classes, attendance and chat history stay in reports. The email address becomes free, so you can add the teacher again later
            as a new account.
          </p>
        </ConfirmDialog>
      )}
      {secret && <SecretOnce title={secret.title} lines={secret.lines} onClose={() => setSecret(null)} />}
      {error && (
        <p className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm text-danger-fg" role="alert">
          {error}
        </p>
      )}

      <Card>
        <CardHeader
          title="Add teacher"
          subtitle="The teacher gets a temporary password (shown once) and a permanent meeting code."
        />
        <form onSubmit={create} className="grid gap-4 sm:grid-cols-2">
          <Input label="Name" name="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={80} />
          <Input
            label="Email"
            name="email"
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            required
          />
          <div className="sm:col-span-2">
            <span className="label">Assigned grades / divisions</span>
            <AssignmentsPicker value={form.assignments} onChange={(a) => setForm({ ...form, assignments: a })} options={gradeOptions} />
            <p className="mt-1.5 text-xs text-slate-500">
              Pick a campus, a grade and a division (or All divisions for the whole grade). Ad-hoc classes are limited to these. Lists come from
              Grades &amp; divisions.
            </p>
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create teacher'}
            </Button>
          </div>
        </form>
      </Card>

      <Card padding={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 p-5 sm:p-6">
          <h2 className="font-display text-lg font-semibold">All teachers {teachers ? `(${teachers.length})` : ''}</h2>
          <input
            className="input max-w-xs"
            placeholder="Search name, email, campus, grade"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Search teachers"
          />
        </div>
        {!teachers ? (
          <p className="px-6 pb-6 text-sm text-slate-400">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-slate-400">No teachers yet.</p>
        ) : (
          <ul className="divide-y divide-white/5">
            {shown.map((t) => (
              <li key={t.id} className="flex flex-col gap-3 px-5 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
                {editing === t.id ? (
                  <form
                    className="grid w-full items-start gap-3 sm:grid-cols-[1fr_2fr_auto]"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (await patch(t.id, editForm)) setEditing(null);
                    }}
                  >
                    <input className="input" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} aria-label="Name" required />
                    <AssignmentsPicker value={editForm.assignments} onChange={(a) => setEditForm({ ...editForm, assignments: a })} options={gradeOptions} />
                    <div className="flex gap-2">
                      <Button type="submit" size="sm">Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-white">{t.name}</p>
                        {t.disabled && <Badge tone="danger">Disabled</Badge>}
                        {t.mustChangePassword && !t.disabled && <Badge tone="warning">Temporary password</Badge>}
                      </div>
                      <p className="truncate text-sm text-slate-400">{t.email}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        Code <span className="font-mono text-brand-300">{t.permanentCode}</span> ·{' '}
                        {t.assignmentsText ? t.assignmentsText.replace(/@/g, ' · ') : 'No grades assigned'}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setEditing(t.id);
                          setEditForm({ name: t.name, assignments: t.assignmentsText });
                        }}
                      >
                        Edit
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => void resetPassword(t)}>
                        Reset password
                      </Button>
                      <Button
                        size="sm"
                        variant={t.disabled ? 'secondary' : 'warning'}
                        onClick={() => {
                          if (t.disabled || confirm(`Disable ${t.name}? They are signed out and cannot sign in.`)) {
                            void patch(t.id, { disabled: !t.disabled });
                          }
                        }}
                      >
                        {t.disabled ? 'Enable' : 'Disable'}
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => setDeleting(t)}>
                        Delete
                      </Button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

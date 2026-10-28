'use client';

import { useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { api } from '@/lib/clientFetch';

export default function SettingsPage() {
  return (
    <AdminShell title="Class size and microphones">
      <Settings />
    </AdminShell>
  );
}

function Settings() {
  const [mics, setMics] = useState('0');
  const [seats, setSeats] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Item 11: 'loading' | 'ready' | an error message. Never the form and an error together.
  const [loadState, setLoadState] = useState<string>('loading');

  useEffect(() => {
    api<{ maxOpenStudentMics: number; maxStudentsPerClass: number | null }>('/api/admin/settings').then(({ ok, data }) => {
      if (!ok) {
        setLoadState(data.error || 'Could not load settings');
        return;
      }
      setLoadState('ready');
      setMics(String(data.maxOpenStudentMics ?? 0));
      setSeats(data.maxStudentsPerClass ? String(data.maxStudentsPerClass) : '');
    });
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setNotice('');
    const maxOpenStudentMics = Number(mics);
    const maxStudentsPerClass = seats.trim() === '' ? null : Number(seats);
    const { ok, data } = await api('/api/admin/settings', { method: 'PUT', body: { maxOpenStudentMics, maxStudentsPerClass } });
    if (!ok) setError(data.error || 'Could not save');
    else setNotice('Saved. 0 or empty means no limit.');
  }

  if (loadState === 'loading') return <p className="text-sm text-slate-400">Loading…</p>;
  if (loadState !== 'ready') {
    return (
      <p className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm text-danger-fg" role="alert">
        {loadState}
      </p>
    );
  }

  return (
    <Card>
      <CardHeader title="Optional limits" subtitle="There is no built-in cap. A full class is reported only when a student limit is set." />
      <form className="max-w-md space-y-3" onSubmit={(e) => void save(e)}>
        <label className="block">
          <span className="label">Student microphones open at once</span>
          <input className="input" inputMode="numeric" value={mics} onChange={(e) => setMics(e.target.value)} />
          <span className="mt-1 block text-xs text-slate-500">0 = no cap. Above that, extra students wait and the teacher sees the queue.</span>
        </label>
        <label className="block">
          <span className="label">Students per class</span>
          <input className="input" inputMode="numeric" placeholder="No limit" value={seats} onChange={(e) => setSeats(e.target.value)} />
        </label>
        {error && <p className="text-sm text-red-300">{error}</p>}
        {notice && <p className="text-sm text-emerald-300">{notice}</p>}
        <Button type="submit">Save</Button>
      </form>
    </Card>
  );
}

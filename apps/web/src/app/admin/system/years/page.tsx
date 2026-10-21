'use client';

import { useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { api } from '@/lib/clientFetch';

type Year = { id: string; label: string; active: boolean };

export default function YearsPage() {
  return (
    <AdminShell title="Academic years">
      <Years />
    </AdminShell>
  );
}

function Years() {
  const [years, setYears] = useState<Year[]>([]);
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');

  async function load() {
    const { ok, data } = await api<{ years: Year[] }>('/api/admin/academic-years');
    if (ok) setYears(data.years);
    else setError(data.error || 'Could not load years');
  }
  useEffect(() => {
    void load();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const { ok, data } = await api('/api/admin/academic-years', { method: 'POST', body: { label } });
    if (!ok) setError(data.error || 'Could not add');
    else {
      setLabel('');
      void load();
    }
  }

  return (
    <Card>
      <CardHeader title="June–May labels" subtitle="Example: 2026-27. Existing classes were filled in from their dates." />
      {error && <p className="mb-3 text-sm text-red-300">{error}</p>}
      <form className="mb-4 flex flex-wrap gap-2" onSubmit={(e) => void add(e)}>
        <input className="input max-w-xs" placeholder="2026-27" value={label} onChange={(e) => setLabel(e.target.value)} />
        <Button type="submit">Add year</Button>
      </form>
      <ul className="divide-y divide-white/5">
        {years.map((y) => (
          <li key={y.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="font-mono">
              {y.label} {!y.active && <span className="text-slate-500">(inactive)</span>}
            </span>
            <span className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => void api(`/api/admin/academic-years/${y.id}`, { method: 'PATCH', body: { active: !y.active } }).then(load)}>
                {y.active ? 'Deactivate' : 'Activate'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void api(`/api/admin/academic-years/${y.id}`, { method: 'DELETE' }).then(({ ok, data }) => (ok ? load() : setError(data.error || 'Could not delete')))}>
                Delete
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

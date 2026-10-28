'use client';

import { useState } from 'react';
import { api } from '@/lib/clientFetch';

/** Teacher ⇄ admin view for a teacher who also holds a sub-admin role (one login). */
export function SwitchViewButton({ to }: { to: 'admin' | 'teacher' }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function go() {
    setBusy(true);
    setError('');
    const { ok, data } = await api<{ to: string }>('/api/auth/switch-view', { method: 'POST', body: { to } });
    if (ok && data.to) window.location.assign(data.to);
    else {
      setBusy(false);
      setError(data.error || 'Could not switch view');
    }
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" className="btn-ghost px-3 py-1.5 text-xs" disabled={busy} onClick={() => void go()}>
        {to === 'admin' ? 'Admin view' : 'Teacher view'}
      </button>
      {error && (
        <span className="text-xs text-danger-fg" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

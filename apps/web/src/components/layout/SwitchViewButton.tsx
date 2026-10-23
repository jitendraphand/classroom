'use client';

import { useState } from 'react';
import { api } from '@/lib/clientFetch';

/** Teacher ⇄ admin view for a teacher who also holds a sub-admin role (one login). */
export function SwitchViewButton({ to }: { to: 'admin' | 'teacher' }) {
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    const { ok, data } = await api<{ to: string }>('/api/auth/switch-view', { method: 'POST', body: { to } });
    if (ok && data.to) window.location.assign(data.to);
    else {
      setBusy(false);
      alert(data.error || 'Could not switch view');
    }
  }
  return (
    <button type="button" className="btn-ghost px-3 py-1.5 text-xs" disabled={busy} onClick={() => void go()}>
      {to === 'admin' ? 'Admin view' : 'Teacher view'}
    </button>
  );
}

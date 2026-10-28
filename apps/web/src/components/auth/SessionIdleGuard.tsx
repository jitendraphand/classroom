'use client';

import { useEffect, useState } from 'react';
import { useIdleLogout } from '@/hooks/useIdleLogout';

/** Mount once in the root layout: idle logout everywhere, with a one-minute warning first. */
export function SessionIdleGuard() {
  const { signOutAt, stay } = useIdleLogout();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!signOutAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [signOutAt]);
  if (!signOutAt) return null;
  const left = Math.max(0, Math.ceil((signOutAt - now) / 1000));
  return (
    <div
      role="alertdialog"
      aria-labelledby="idle-title"
      aria-describedby="idle-body"
      className="fixed inset-x-4 bottom-4 z-[200] mx-auto max-w-md rounded-2xl border border-amber-400/30 bg-slate-900 p-4 shadow-2xl sm:inset-x-auto sm:right-4"
    >
      <p id="idle-title" className="font-semibold text-white">
        Still there?
      </p>
      <p id="idle-body" className="mt-1 text-sm text-slate-300">
        You will be signed out in {left} s because there has been no activity for a while.
      </p>
      <button type="button" className="btn-primary mt-3 px-4 py-2 text-sm" onClick={stay} autoFocus>
        Stay signed in
      </button>
    </div>
  );
}

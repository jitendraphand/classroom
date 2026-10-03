'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  SESSION_CHECK_EVENT,
  SESSION_ENDED_EVENT,
  endedSessionCopy,
  isEndedReason,
  loginHref,
  shouldCheckAfter401,
  type EndedReason,
} from '@/lib/sessionClient';

/**
 * One active session per teacher/admin, client half. Mounted once in the root
 * layout. Checks /api/auth/status on load, after any 401 from an app API, when
 * the tab becomes visible and every 30 s for staff. When the session was
 * replaced (or revoked) it fires SESSION_ENDED_EVENT, so an open class or admin
 * viewer disconnects from LiveKit, and shows a full-screen notice with
 * "Sign in here".
 */
export function StaffSessionGuard() {
  const pathname = usePathname();
  const [reason, setReason] = useState<EndedReason | null>(null);

  useEffect(() => {
    const origFetch = window.fetch.bind(window);
    let checking = false;
    let ended = false;
    let staff = false;

    const check = async () => {
      if (checking || ended) return;
      checking = true;
      try {
        const res = await origFetch('/api/auth/status', { cache: 'no-store' });
        const data = (await res.json().catch(() => ({}))) as { role?: string | null; reason?: unknown };
        if (data.role) staff = true;
        if (isEndedReason(data.reason)) {
          ended = true;
          setReason(data.reason);
          window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT, { detail: { reason: data.reason } }));
        }
      } catch {
        /* offline: try again later */
      } finally {
        checking = false;
      }
    };

    const patched: typeof window.fetch = async (input, init) => {
      const res = await origFetch(input, init);
      if (res.status === 401) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (shouldCheckAfter401(url, window.location.origin)) void check();
      }
      return res;
    };
    window.fetch = patched;

    void check();
    const tick = () => {
      if (staff && document.visibilityState === 'visible') void check();
    };
    const iv = window.setInterval(tick, 30_000);
    const onCheck = () => void check();
    document.addEventListener('visibilitychange', tick);
    window.addEventListener(SESSION_CHECK_EVENT, onCheck);
    return () => {
      if (window.fetch === patched) window.fetch = origFetch;
      window.clearInterval(iv);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener(SESSION_CHECK_EVENT, onCheck);
    };
  }, []);

  // The login page shows the reason itself.
  if (!reason || pathname?.startsWith('/login')) return null;
  const copy = endedSessionCopy(reason);
  const signIn = () => {
    const here = `${window.location.pathname}${window.location.search}`;
    window.location.href = loginHref(reason, reason === 'disabled' ? null : here);
  };

  return (
    <div
      className="fixed inset-0 z-[2147483000] flex items-center justify-center bg-slate-950/90 px-6 backdrop-blur-sm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="session-ended-title"
    >
      <div className="max-w-md rounded-2xl border border-white/10 bg-surface-1 p-8 text-center shadow-lift">
        <p id="session-ended-title" className="font-display text-2xl font-semibold tracking-tight">
          {copy.title}
        </p>
        <p className="mt-2 text-sm text-slate-400">{copy.body}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          {reason !== 'disabled' && (
            <button type="button" className="btn-primary px-5 py-2.5" onClick={signIn}>
              Sign in here
            </button>
          )}
          <button
            type="button"
            className="btn-ghost px-5 py-2.5"
            onClick={() => {
              window.location.href = '/';
            }}
          >
            Home
          </button>
        </div>
      </div>
    </div>
  );
}

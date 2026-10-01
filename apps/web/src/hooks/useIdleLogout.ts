'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { isLiveSession, onLiveSessionChange, onReportedActivity } from '@/lib/liveSession';

/** 15 minutes of no pointer/keyboard/touch activity → sign out. */
const IDLE_MS = 15 * 60 * 1000;
/** Throttle activity resets so mousemove does not thrash timers. */
const ACTIVITY_THROTTLE_MS = 1_000;

const ACTIVITY_EVENTS: Array<keyof WindowEventMap> = [
  'mousemove',
  'mousedown',
  'keydown',
  'touchstart',
  'touchmove',
  'scroll',
  'wheel',
  'pointerdown',
  'click',
];

/**
 * Keeps JWT/cookie sessions across reloads; only logs out after IDLE_MS with
 * no user activity. Applies to both teacher and student authenticated sessions.
 *
 * Suspended while connected to a live classroom (see lib/liveSession): a
 * teacher presenting from another app or from the share pop-out, and a student
 * who is only watching, must not be signed out mid-class. Activity reported by
 * the pop-out / PiP window also counts. The 15-minute timer applies everywhere
 * else (dashboard, lobby, login pages) and restarts when the class ends.
 */
export function useIdleLogout() {
  const router = useRouter();
  const pathname = usePathname();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActivityRef = useRef(0);
  const authedRef = useRef(false);
  const signingOutRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function refreshAuth() {
      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store' });
        const data = await res.json();
        if (cancelled) return;
        authedRef.current = data.role === 'teacher' || data.role === 'student' || data.role === 'admin';
        if (authedRef.current) armTimer();
        else clearTimer();
      } catch {
        /* ignore transient network errors */
      }
    }

    function clearTimer() {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }

    function armTimer() {
      clearTimer();
      if (!authedRef.current || signingOutRef.current) return;
      if (isLiveSession()) return;
      timerRef.current = setTimeout(() => {
        void signOutIdle();
      }, IDLE_MS);
    }

    async function signOutIdle() {
      if (signingOutRef.current || !authedRef.current) return;
      if (isLiveSession()) return;
      signingOutRef.current = true;
      try {
        await fetch('/api/auth/logout', { method: 'POST' });
      } catch {
        /* still redirect */
      }
      authedRef.current = false;
      clearTimer();
      const dest = pathname?.startsWith('/join') || pathname?.startsWith('/classroom')
        ? '/'
        : '/login';
      router.replace(dest);
      // Allow a future login in this SPA session to re-arm.
      signingOutRef.current = false;
    }

    function onActivity() {
      if (!authedRef.current) return;
      const now = Date.now();
      if (now - lastActivityRef.current < ACTIVITY_THROTTLE_MS) return;
      lastActivityRef.current = now;
      armTimer();
    }

    void refreshAuth();
    // Re-check auth when route changes (login → dashboard, join → classroom).
    const authPoll = window.setInterval(() => {
      void refreshAuth();
    }, 60_000);

    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, onActivity, { passive: true, capture: true });
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') onActivity();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const offActivity = onReportedActivity(onActivity);
    // Joining a live room suspends the timer; leaving it starts a fresh one.
    const offLive = onLiveSessionChange(() => armTimer());

    return () => {
      cancelled = true;
      clearTimer();
      window.clearInterval(authPoll);
      for (const ev of ACTIVITY_EVENTS) {
        window.removeEventListener(ev, onActivity, true);
      }
      document.removeEventListener('visibilitychange', onVisibility);
      offActivity();
      offLive();
    };
  }, [router, pathname]);
}

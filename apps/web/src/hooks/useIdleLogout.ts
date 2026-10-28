'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { CLASS_FINISHED_EVENT } from '@/lib/classFinishEvent';
import { isLiveSession, onLiveSessionChange, onReportedActivity } from '@/lib/liveSession';
import { jitterMs } from '@/lib/pollPolicy';

/** 15 minutes of no pointer/keyboard/touch activity → sign out. */
const IDLE_MS = 15 * 60 * 1000;
/** A "you will be signed out" warning this long before it happens. */
export const IDLE_WARNING_MS = 60 * 1000;

/**
 * Pages people watch without touching: the admin live wall and the observer
 * view. Like a live class, they must not sign the admin out.
 */
export function isPassivePage(pathname: string | null | undefined): boolean {
  return !!pathname && (pathname === '/admin/live' || pathname.startsWith('/admin/live/'));
}
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
/** auth/me re-check period (was 60 s) and, during a live class, the slower one. */
export const AUTH_POLL_MS = 120_000;
export const AUTH_POLL_LIVE_MS = 600_000;

export function useIdleLogout(): { signOutAt: number | null; stay: () => void } {
  const router = useRouter();
  const pathname = usePathname();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastActivityRef = useRef(0);
  const authedRef = useRef(false);
  const signingOutRef = useRef(false);
  /** When the pending idle sign-out happens (the warning is showing), else null. */
  const [signOutAt, setSignOutAt] = useState<number | null>(null);
  const stayRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;

    let lastAuthAt = 0;
    async function refreshAuth() {
      lastAuthAt = Date.now();
      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store' });
        const data = await res.json();
        if (cancelled) return;
        // School-app students are not idle-logged out: their session can only be
        // re-created from the school app, and they often just wait or watch.
        authedRef.current =
          data.role === 'teacher' || data.role === 'admin' || (data.role === 'student' && !data.viaSchoolApp);
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
      setSignOutAt(null);
    }

    function armTimer() {
      clearTimer();
      if (!authedRef.current || signingOutRef.current) return;
      if (isLiveSession() || isPassivePage(pathname)) return;
      // Warn first, then sign out: unsaved form input is not lost without notice.
      timerRef.current = setTimeout(() => {
        setSignOutAt(Date.now() + IDLE_WARNING_MS);
        timerRef.current = setTimeout(() => {
          void signOutIdle();
        }, IDLE_WARNING_MS);
      }, IDLE_MS - IDLE_WARNING_MS);
    }

    async function signOutIdle() {
      if (signingOutRef.current || !authedRef.current) return;
      if (isLiveSession() || isPassivePage(pathname)) return;
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

    stayRef.current = () => {
      lastActivityRef.current = 0;
      onActivity();
    };

    void refreshAuth();
    // Re-check auth when route changes (login → dashboard, join → classroom).
    // Every ~2 min (jittered so a class does not align). In a live class the
    // idle timer is off anyway: re-check only every AUTH_POLL_LIVE_MS there.
    const authPoll = window.setInterval(() => {
      if (isLiveSession() && Date.now() - lastAuthAt < AUTH_POLL_LIVE_MS) return;
      void refreshAuth();
    }, jitterMs(AUTH_POLL_MS));

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
    // A student's finished class view makes no more requests: stop polling.
    const onFinished = () => {
      cancelled = true;
      authedRef.current = false;
      clearTimer();
      window.clearInterval(authPoll);
    };
    window.addEventListener(CLASS_FINISHED_EVENT, onFinished);

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
      window.removeEventListener(CLASS_FINISHED_EVENT, onFinished);
    };
  }, [router, pathname]);

  return { signOutAt, stay: () => stayRef.current() };
}

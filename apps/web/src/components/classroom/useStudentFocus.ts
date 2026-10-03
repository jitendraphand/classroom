'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { roomFetch } from '@/lib/classroomClient';
import { computeFocusStatus, isIPhoneUA, type FocusStatus } from '@/lib/focusStatus';

type WebkitDoc = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
};
type WebkitEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

export function fullscreenSupported(): boolean {
  if (typeof document === 'undefined') return false;
  const d = document as WebkitDoc;
  return !!(d.fullscreenEnabled || d.webkitFullscreenEnabled);
}

function isFullscreenNow(): boolean {
  const d = document as WebkitDoc;
  return !!(d.fullscreenElement || d.webkitFullscreenElement);
}

function readStatus(): FocusStatus {
  return computeFocusStatus({
    fullscreenSupported: fullscreenSupported(),
    isFullscreen: isFullscreenNow(),
    hidden: document.visibilityState === 'hidden',
  });
}

/** requestFullscreen with the webkit fallback (older Safari, iPadOS). Needs a user gesture. */
export async function enterFullscreen(): Promise<boolean> {
  const el = document.documentElement as WebkitEl;
  try {
    if (isFullscreenNow()) return true;
    if (typeof el.requestFullscreen === 'function') {
      await el.requestFullscreen({ navigationUI: 'hide' });
    } else if (typeof el.webkitRequestFullscreen === 'function') {
      await el.webkitRequestFullscreen();
    }
  } catch {
    /* blocked (no gesture) or refused */
  }
  return isFullscreenNow();
}

/**
 * Student fullscreen enforcement. Detects leaving fullscreen
 * (fullscreenchange / webkitfullscreenchange) and leaving the page
 * (visibilitychange → hidden), reports each change to the teacher, and tells
 * the page when to show the "Tap to return to fullscreen" cover. Browsers
 * without the Fullscreen API (iPhone Safari) get focus mode instead and are
 * reported as unsupported, not as having left.
 */
export function useStudentFocus(code: string, enabled: boolean) {
  const [status, setStatus] = useState<FocusStatus>(() =>
    typeof document === 'undefined' ? 'fullscreen' : readStatus()
  );
  const [iphone] = useState(() => typeof navigator !== 'undefined' && isIPhoneUA(navigator.userAgent || ''));
  const [portrait, setPortrait] = useState(false);
  const lastSent = useRef<string>('');
  const sendTimer = useRef<number | null>(null);

  const report = useCallback(
    (next: FocusStatus, immediate: boolean) => {
      const key = next;
      if (key === lastSent.current) return;
      const send = () => {
        lastSent.current = key;
        void roomFetch(code, '/focus', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: next, iphone }),
          // Survives the page being hidden / frozen right after.
          keepalive: true,
        }).catch(() => {
          lastSent.current = '';
        });
      };
      if (sendTimer.current) window.clearTimeout(sendTimer.current);
      sendTimer.current = null;
      if (immediate) send();
      // Short debounce so the Esc → re-enter flicker is not two alerts.
      else sendTimer.current = window.setTimeout(send, 600);
    },
    [code, iphone]
  );

  useEffect(() => {
    if (!enabled) return;
    const update = () => {
      const next = readStatus();
      setStatus(next);
      report(next, next === 'away');
    };
    update();
    // Try once on join (browsers usually want a gesture), then on the first tap/key.
    if (fullscreenSupported() && !isFullscreenNow()) void enterFullscreen().then(update);
    const onGesture = () => {
      if (fullscreenSupported() && !isFullscreenNow()) void enterFullscreen().then(update);
    };
    document.addEventListener('fullscreenchange', update);
    document.addEventListener('webkitfullscreenchange', update);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('pageshow', update);
    document.addEventListener('pointerdown', onGesture, { once: true });
    document.addEventListener('keydown', onGesture, { once: true });
    return () => {
      document.removeEventListener('fullscreenchange', update);
      document.removeEventListener('webkitfullscreenchange', update);
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('pageshow', update);
      document.removeEventListener('pointerdown', onGesture);
      document.removeEventListener('keydown', onGesture);
      if (sendTimer.current) window.clearTimeout(sendTimer.current);
    };
  }, [enabled, report]);

  // Portrait hint for focus mode (no Fullscreen API).
  useEffect(() => {
    if (!enabled || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(orientation: portrait)');
    const sync = () => setPortrait(mq.matches);
    sync();
    mq.addEventListener?.('change', sync);
    return () => mq.removeEventListener?.('change', sync);
  }, [enabled]);

  const returnToFullscreen = useCallback(async () => {
    await enterFullscreen();
    const next = readStatus();
    setStatus(next);
    report(next, true);
  }, [report]);

  return { status, iphone, portrait, focusMode: status === 'unsupported', returnToFullscreen };
}

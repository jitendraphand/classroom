'use client';

import { useEffect } from 'react';

type WakeLockNav = Navigator & {
  wakeLock?: {
    request: (type: 'screen') => Promise<{ release: () => Promise<void>; addEventListener?: (t: string, fn: () => void) => void }>;
  };
};

/**
 * Keep mobile/tablet screens awake during a live class without ever prompting
 * or failing loudly. Releases automatically when the tab hides and re-acquires
 * when visible again.
 */
export function useScreenWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || typeof document === 'undefined') return;
    const nav = navigator as WakeLockNav;
    if (!nav.wakeLock?.request) return;

    let cancelled = false;
    let sentinel: { release: () => Promise<void> } | null = null;

    const acquire = async () => {
      if (cancelled || document.visibilityState !== 'visible' || sentinel) return;
      try {
        const lock = await nav.wakeLock!.request('screen');
        if (cancelled) {
          void lock.release().catch(() => undefined);
          return;
        }
        sentinel = lock;
        lock.addEventListener?.('release', () => {
          if (sentinel === lock) sentinel = null;
        });
      } catch {
        /* battery saver, policy, or unsupported: ignore quietly */
      }
    };

    const onVis = () => {
      if (document.visibilityState === 'visible') void acquire();
      else sentinel = null;
    };

    void acquire();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVis);
      const cur = sentinel;
      sentinel = null;
      if (cur) void cur.release().catch(() => undefined);
    };
  }, [active]);
}

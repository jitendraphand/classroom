/**
 * Tiny browser-side signal between a live classroom and the idle-logout guard.
 *
 * - While a LiveKit room is connected, idle logout is suspended: a teacher who
 *   presents from another app (or only touches the share pop-out) and a
 *   student who is just watching must not be signed out mid-class.
 * - Activity in other windows the app owns (the share-controls pop-out or
 *   Document PiP) is reported here so it counts as activity.
 */

const LIVE_EVENT = 'classroom:live-session';
const ACTIVITY_EVENT = 'classroom:activity';

let live = false;

export function isLiveSession(): boolean {
  return live;
}

export function setLiveSession(active: boolean) {
  if (typeof window === 'undefined' || live === active) return;
  live = active;
  window.dispatchEvent(new CustomEvent(LIVE_EVENT, { detail: active }));
}

export function reportActivity() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(ACTIVITY_EVENT));
}

export function onLiveSessionChange(cb: (active: boolean) => void): () => void {
  const handler = (e: Event) => cb(!!(e as CustomEvent<boolean>).detail);
  window.addEventListener(LIVE_EVENT, handler);
  return () => window.removeEventListener(LIVE_EVENT, handler);
}

export function onReportedActivity(cb: () => void): () => void {
  window.addEventListener(ACTIVITY_EVENT, cb);
  return () => window.removeEventListener(ACTIVITY_EVENT, cb);
}

/** Forward pointer/keyboard activity from another window (pop-out, PiP). */
export function forwardActivityFrom(win: Window): () => void {
  const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
  let last = 0;
  const handler = () => {
    const now = Date.now();
    if (now - last < 1_000) return;
    last = now;
    reportActivity();
  };
  for (const ev of events) {
    try {
      win.addEventListener(ev, handler, { passive: true, capture: true });
    } catch {
      /* window already closed */
    }
  }
  return () => {
    for (const ev of events) {
      try {
        win.removeEventListener(ev, handler, true);
      } catch {
        /* window already closed */
      }
    }
  };
}

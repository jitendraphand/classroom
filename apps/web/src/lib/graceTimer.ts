/**
 * Keyed "do this later unless cancelled" timers. Used for the 15 s grace period
 * before students are force-muted when the teacher's connection drops (device
 * switch, reload, network blip): a teacher reconnect cancels it. Pure (timer
 * functions injected) so the rules are unit-tested with a fake clock.
 */

/** How long the class waits for the teacher to come back before locking student mics. */
export const TEACHER_ABSENCE_GRACE_MS = 15_000;

type Handle = unknown;

export type GraceTimers = {
  /** (Re)start the timer for `key`; `fn` runs after the delay unless cancelled first. */
  schedule: (key: string, fn: () => void | Promise<void>) => void;
  /** Cancel a pending timer; true if one was pending. */
  cancel: (key: string) => boolean;
  isPending: (key: string) => boolean;
};

export function createGraceTimers(opts: {
  delayMs: number;
  setTimer?: (fn: () => void, ms: number) => Handle;
  clearTimer?: (h: Handle) => void;
}): GraceTimers {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const pending = new Map<string, Handle>();

  const cancel = (key: string) => {
    const h = pending.get(key);
    if (h === undefined) return false;
    clearTimer(h);
    pending.delete(key);
    return true;
  };

  return {
    schedule(key, fn) {
      cancel(key);
      const h = setTimer(() => {
        if (pending.get(key) !== h) return;
        pending.delete(key);
        void Promise.resolve()
          .then(fn)
          .catch((e) => console.error('grace timer', key, e instanceof Error ? e.message : e));
      }, opts.delayMs);
      pending.set(key, h);
    },
    cancel,
    isPending: (key) => pending.has(key),
  };
}

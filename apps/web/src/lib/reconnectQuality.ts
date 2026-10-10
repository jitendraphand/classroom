/**
 * Smart reconnect (pure, shared): after a network change / reconnect the
 * student resumes on low layers and steps back up once the link has been
 * stable for STEP_UP_MS.
 */
export const STEP_UP_MS = 8000;

export type LinkPhase = 'stable' | 'recovering';

export function createStepUp(
  onPhase: (p: LinkPhase) => void,
  opts: { stepUpMs?: number; schedule?: (fn: () => void, ms: number) => unknown; cancel?: (t: unknown) => void } = {}
) {
  const ms = opts.stepUpMs ?? STEP_UP_MS;
  const schedule = opts.schedule ?? ((fn: () => void, t: number) => setTimeout(fn, t));
  const cancel = opts.cancel ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let phase: LinkPhase = 'stable';
  let timer: unknown = null;
  const set = (p: LinkPhase) => {
    if (p === phase) return;
    phase = p;
    onPhase(p);
  };
  return {
    /** Reconnecting, network type change, or back online. */
    disturbed() {
      if (timer !== null) cancel(timer);
      timer = null;
      set('recovering');
    },
    /** Connected again: step up after a quiet period (another disturbance restarts it). */
    connected() {
      if (phase !== 'recovering') return;
      if (timer !== null) cancel(timer);
      timer = schedule(() => {
        timer = null;
        set('stable');
      }, ms);
    },
    phase: () => phase,
    dispose() {
      if (timer !== null) cancel(timer);
      timer = null;
    },
  };
}

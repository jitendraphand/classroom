/**
 * Keeps a Windows.Graphics.Capture share alive across display and session changes.
 *
 * E2E 2026-10-09: after a Remote Desktop reconnect / detach the WGC session
 * silently stopped producing new frames; the helper kept re-sending the last
 * texture as a keep-alive, so students saw a frozen picture while the HUD said
 * LIVE. Recovery restarts the helper (a fresh GraphicsCaptureItem, D3D device and
 * frame pool) with the target re-resolved for the current display layout. The
 * renderer keeps the same MediaStreamTrack (it is fed by IPC frames), so the
 * published LiveKit track never changes and students do not re-subscribe.
 *
 * Triggers:
 * - the helper exits on its own (it exits with code 3 after a `stale` event:
 *   device lost, monitor geometry changed, input desktop / remote session
 *   changed, or GDI shows a different screen than its frozen WGC texture);
 * - display-added / -removed / -metrics-changed, unlock-screen, resume,
 *   session events from Electron (main.ts wires them to `trigger`);
 * - watchdog: no frame at all from the helper for NO_FRAME_MS (keep-alives
 *   arrive every 250 ms, so silence means the helper hung).
 * Restarts back off (RETRY_DELAYS_MS). When every attempt fails the share is
 * reported as failed so the class shows a status instead of a frozen picture.
 */

export const NO_FRAME_MS = 3000;
export const EVENT_DEBOUNCE_MS = 800;
export const RETRY_DELAYS_MS = [0, 1000, 2000, 4000, 8000] as const;

export type CaptureTarget = { kind: 'monitor'; displayId: string; rect: Rect } | { kind: 'window'; hwnd: string };
export type Rect = { x: number; y: number; w: number; h: number };

export type StartResult = { ok: true; width: number; height: number } | { ok: false; error: string };

export type CaptureStatus =
  | { state: 'recovering'; reason: string; attempt: number }
  | { state: 'recovered'; reason: string; attempt: number }
  | { state: 'failed'; reason: string; attempt: number };

export type SupervisorDeps = {
  start: (args: string[]) => Promise<StartResult>;
  /** Helper arguments for `target` at `fps` with the CURRENT display layout, or null if the target is gone. */
  argsFor: (target: CaptureTarget, fps: number) => string[] | null;
  onStatus: (status: CaptureStatus) => void;
  onArgs?: (args: string[]) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (line: string) => void;
  delays?: readonly number[];
  debounceMs?: number;
  noFrameMs?: number;
};

export type CaptureSupervisor = {
  /** A share started (or its fps changed) with this target. */
  arm: (target: CaptureTarget, fps: number) => void;
  disarm: () => void;
  armed: () => boolean;
  frame: () => void;
  /** Something changed (display, session, helper exit): restart after a short debounce. */
  trigger: (reason: string) => void;
  /** Call about once a second. */
  tick: () => void;
  /** Resolves when no recovery is running (tests). */
  idle: () => Promise<void>;
};

export function createCaptureSupervisor(deps: SupervisorDeps): CaptureSupervisor {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
  const delays = deps.delays ?? RETRY_DELAYS_MS;
  const debounceMs = deps.debounceMs ?? EVENT_DEBOUNCE_MS;
  const noFrameMs = deps.noFrameMs ?? NO_FRAME_MS;
  const log = deps.log ?? (() => undefined);

  let target: CaptureTarget | null = null;
  let fps = 8;
  let epoch = 0;
  let lastFrame = 0;
  let pending: unknown = null;
  let pendingReason = '';
  let running: Promise<void> | null = null;

  const cancelPending = () => {
    if (pending !== null) clearTimer(pending);
    pending = null;
  };

  async function recover(reason: string, myEpoch: number): Promise<void> {
    for (let attempt = 1; attempt <= delays.length; attempt++) {
      if (myEpoch !== epoch || !target) return;
      const wait = delays[attempt - 1] ?? 0;
      if (wait > 0) await new Promise<void>((resolve) => setTimer(resolve, wait));
      if (myEpoch !== epoch || !target) return;
      deps.onStatus({ state: 'recovering', reason, attempt });
      const args = deps.argsFor(target, fps);
      if (!args) {
        log(`[capture] recovery ${attempt}: target is gone (${reason})`);
        continue;
      }
      let result: StartResult;
      try {
        result = await deps.start(args);
      } catch (err) {
        result = { ok: false, error: String(err) };
      }
      if (myEpoch !== epoch || !target) return;
      if (result.ok) {
        lastFrame = now();
        deps.onArgs?.(args);
        log(`[capture] recovered after ${reason} (attempt ${attempt}) ${result.width}x${result.height}`);
        deps.onStatus({ state: 'recovered', reason, attempt });
        return;
      }
      log(`[capture] recovery ${attempt} failed: ${result.error} (${reason})`);
    }
    if (myEpoch !== epoch) return;
    deps.onStatus({ state: 'failed', reason, attempt: delays.length });
    target = null;
  }

  function startRecovery(reason: string): void {
    if (!target) return;
    if (running) return; // one recovery at a time; it re-resolves the target anyway
    const myEpoch = epoch;
    running = recover(reason, myEpoch).finally(() => {
      running = null;
    });
  }

  return {
    arm(next, nextFps) {
      cancelPending();
      epoch += 1;
      target = next;
      fps = nextFps;
      lastFrame = now();
    },
    disarm() {
      cancelPending();
      epoch += 1;
      target = null;
    },
    armed: () => target !== null,
    frame() {
      lastFrame = now();
    },
    trigger(reason) {
      if (!target) return;
      pendingReason = pendingReason ? pendingReason : reason;
      cancelPending();
      pending = setTimer(() => {
        pending = null;
        const why = pendingReason;
        pendingReason = '';
        startRecovery(why);
      }, debounceMs);
    },
    tick() {
      if (!target || running || pending !== null) return;
      if (now() - lastFrame >= noFrameMs) startRecovery('no-frames');
    },
    idle: async () => {
      while (running || pending !== null) {
        if (running) await running;
        else await new Promise((r) => setTimeout(r, 5));
      }
    },
  };
}

/** Helper arguments for a monitor rectangle (physical pixels). */
export function monitorArgs(rect: Rect, maxW: number, maxH: number, fps: number): string[] {
  return [
    'capture-monitor',
    String(rect.x),
    String(rect.y),
    String(rect.x + rect.w),
    String(rect.y + rect.h),
    String(maxW),
    String(maxH),
    String(fps),
  ];
}

/** Pick the display for a recovering monitor share: same id, else the one overlapping the old rect most, else the first. */
export function pickDisplay<T extends { id: string; rect: Rect }>(displays: readonly T[], wantId: string, oldRect: Rect): T | null {
  if (!displays.length) return null;
  const same = displays.find((d) => d.id === wantId);
  if (same) return same;
  let best: T | null = null;
  let bestArea = 0;
  for (const d of displays) {
    const w = Math.min(d.rect.x + d.rect.w, oldRect.x + oldRect.w) - Math.max(d.rect.x, oldRect.x);
    const h = Math.min(d.rect.y + d.rect.h, oldRect.y + oldRect.h) - Math.max(d.rect.y, oldRect.y);
    const area = w > 0 && h > 0 ? w * h : 0;
    if (area > bestArea) {
      bestArea = area;
      best = d;
    }
  }
  return best ?? displays[0]!;
}

/**
 * Adaptive screen capture for weak / busy teacher PCs.
 * Main process samples total CPU every few seconds while sharing; this state
 * machine (with hysteresis) picks a capture level. Level → sidecar maxHeight + fps cap.
 */
export type CaptureLevel = 0 | 1 | 2;

export interface AdaptiveState {
  level: CaptureLevel;
  hot: number; // consecutive busy samples
  cool: number; // consecutive idle samples
}

export const HIGH_CPU = 0.85;
export const LOW_CPU = 0.55;
export const HOT_SAMPLES = 2; // ~6 s busy → step down
export const COOL_SAMPLES = 5; // ~15 s calm → step up

/** Two cores or fewer start one level down. */
export function initialState(cores: number): AdaptiveState {
  return { level: cores > 0 && cores <= 2 ? 1 : 0, hot: 0, cool: 0 };
}

export function nextState(s: AdaptiveState, cpu: number): AdaptiveState {
  if (!Number.isFinite(cpu)) return s;
  if (cpu >= HIGH_CPU) {
    const hot = s.hot + 1;
    if (hot >= HOT_SAMPLES && s.level < 2) return { level: (s.level + 1) as CaptureLevel, hot: 0, cool: 0 };
    return { ...s, hot, cool: 0 };
  }
  if (cpu <= LOW_CPU) {
    const cool = s.cool + 1;
    if (cool >= COOL_SAMPLES && s.level > 0) return { level: (s.level - 1) as CaptureLevel, hot: 0, cool: 0 };
    return { ...s, cool, hot: 0 };
  }
  return { ...s, hot: 0, cool: 0 };
}

/** Sidecar settings for a level. maxHeight 0 = native resolution. */
export function levelProfile(level: CaptureLevel, requestedFps: number): { maxHeight: number; fps: number } {
  const fps = Math.max(1, Math.min(30, Math.round(requestedFps) || 8));
  if (level === 2) return { maxHeight: 720, fps: Math.max(4, Math.min(fps, Math.round(fps / 2))) };
  if (level === 1) return { maxHeight: 900, fps: Math.max(5, Math.min(fps, Math.round(fps * 0.75))) };
  return { maxHeight: 0, fps };
}

export interface CpuTimes { idle: number; total: number }

/** Sum of os.cpus() times. */
export function cpuTimes(cpus: { times: { user: number; nice: number; sys: number; idle: number; irq: number } }[]): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

export function busyFraction(a: CpuTimes, b: CpuTimes): number {
  const total = b.total - a.total;
  if (!(total > 0)) return NaN;
  return Math.max(0, Math.min(1, 1 - (b.idle - a.idle) / total));
}

/**
 * Low-power mode (teacher toolbar / settings): fewer frames everywhere.
 * Slides 5 fps (normal 8), Video mode 15 fps (normal 24), student tiles at a
 * lower frame rate and size. Persisted per machine.
 */
export const LOW_POWER_KEY = 'classroom.lowPower';

export const LOW_POWER = {
  slidesFps: 5,
  videoFps: 15,
  tileFps: 7,
  tileSize: { width: 160, height: 90 },
} as const;

export const NORMAL_TILE = { fps: 15, size: { width: 320, height: 180 } } as const;

export function shareFps(opts: { videoMode: boolean; lowPower: boolean; slidesFps: number; videoFps: number }): number {
  if (opts.videoMode) return opts.lowPower ? Math.min(opts.videoFps, LOW_POWER.videoFps) : opts.videoFps;
  return opts.lowPower ? Math.min(opts.slidesFps, LOW_POWER.slidesFps) : opts.slidesFps;
}

/** Cap every encoding's maxFramerate (other fields kept). */
export function capEncodingFps<E extends { maxFramerate?: number }>(encodings: E[], fps: number): E[] {
  return encodings.map((e) => ({ ...e, maxFramerate: Math.min(e.maxFramerate ?? fps, fps) }));
}

export function tileProfile(lowPower: boolean) {
  return lowPower ? { fps: LOW_POWER.tileFps, size: LOW_POWER.tileSize } : NORMAL_TILE;
}

export function parseLowPower(v: unknown): boolean {
  return v === '1' || v === true;
}

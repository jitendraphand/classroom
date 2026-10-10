/**
 * Geometry of a whole-monitor share, mirrored from native/affinity-helper.c so
 * it can be unit-tested at every scale factor.
 *
 * Bug 2026-10-10 (Windows 10, whole-screen share showed only the top-left of
 * the desktop): the helper created its WGC frame pool at the OUTPUT size
 * (fit to 1280×720). WGC never scales into a pool; it copies the top-left
 * pool-sized block of the monitor. The pool is now the monitor's full physical
 * size and the frame is scaled to fit afterwards (GPU video processor, CPU
 * fallback), preserving the aspect ratio.
 */

export type Size = { w: number; h: number };
export type Rect = { x: number; y: number; w: number; h: number };

/** fit_even(): largest even size inside max×max preserving aspect; never upscales. */
export function fitEven(src: Size, max: Size): Size {
  const sw = Math.max(2, src.w);
  const sh = Math.max(2, src.h);
  const mw = Math.max(2, max.w);
  const mh = Math.max(2, max.h);
  let s = 1;
  if (sw > mw) s = mw / sw;
  if (sh * s > mh) s = mh / sh;
  let w = Math.max(2, Math.trunc(sw * s)) & ~1;
  let h = Math.max(2, Math.trunc(sh * s)) & ~1;
  w = Math.max(2, w);
  h = Math.max(2, h);
  return { w, h };
}

/** The helper's frame pool: always the WGC item's (monitor's) full physical size. */
export function framePoolSize(itemPhysical: Size): Size {
  return { w: itemPhysical.w, h: itemPhysical.h };
}

/** Physical monitor rectangle for a display given in DIPs (Electron bounds) and its scale factor. */
export function physicalRect(dip: Rect, scaleFactor: number): Rect {
  const s = scaleFactor > 0 ? scaleFactor : 1;
  return { x: Math.round(dip.x * s), y: Math.round(dip.y * s), w: Math.round(dip.w * s), h: Math.round(dip.h * s) };
}

/**
 * What the published frame shows of the monitor, as a fraction of it:
 * the part of the monitor covered by the pool, scaled to the output.
 */
export function visibleFraction(monitorPhysical: Size, pool: Size): Size {
  return { w: Math.min(1, pool.w / monitorPhysical.w), h: Math.min(1, pool.h / monitorPhysical.h) };
}

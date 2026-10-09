/** Compare panel regions of two captured frames. Test only. Never used on the published stream. */

export type DiffRect = { x: number; y: number; w: number; h: number };

export type PixelDiff = {
  compared: number;
  changed: number;
  ratio: number;
  pass: boolean;
};

/**
 * A pixel counts as changed when the sum of absolute RGB differences exceeds
 * `channelTolerance` on each channel. Alpha is ignored. Pass means the panel
 * regions match the reference (the desktop with the panels hidden).
 */
export function panelPixelDiff(
  reference: ArrayLike<number>,
  live: ArrayLike<number>,
  width: number,
  height: number,
  rects: readonly DiffRect[],
  opts: { channelTolerance?: number; passRatio?: number } = {}
): PixelDiff {
  const tol = opts.channelTolerance ?? 12;
  const limit = tol * 3;
  const passRatio = opts.passRatio ?? 0.02;
  let compared = 0;
  let changed = 0;
  const need = width * height * 4;
  if (width < 2 || height < 2 || reference.length < need || live.length < need) {
    return { compared: 0, changed: 0, ratio: 1, pass: false };
  }
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(width, Math.ceil(r.x + r.w));
    const y1 = Math.min(height, Math.ceil(r.y + r.h));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        compared += 1;
        const d =
          Math.abs((reference[i] ?? 0) - (live[i] ?? 0)) +
          Math.abs((reference[i + 1] ?? 0) - (live[i + 1] ?? 0)) +
          Math.abs((reference[i + 2] ?? 0) - (live[i + 2] ?? 0));
        if (d > limit) changed += 1;
      }
    }
  }
  if (!compared) return { compared: 0, changed: 0, ratio: 1, pass: false };
  const ratio = changed / compared;
  return { compared, changed, ratio, pass: ratio <= passRatio };
}

/**
 * Content-change detection for Windows.Graphics.Capture frames.
 *
 * The helper re-sends the last frame every 250 ms as a keep-alive, and WGC
 * itself fires a frame when a capture-EXCLUDED window (student video tiles,
 * control panel) repaints, even though those pixels come out unchanged. Counting
 * arrivals therefore never drops under 4/s and Video mode could never switch
 * back to slides. Video mode now counts frames whose *pixels* changed.
 *
 * The signature samples a fixed grid (GRID_W × GRID_H points, each a 2×2 block
 * average) so a 1280×720 frame costs ~9k reads, cheap at 30 fps.
 */

export const GRID_W = 64;
export const GRID_H = 36;
/** Sum of |ΔR|+|ΔG|+|ΔB| over which a grid point counts as changed. */
export const POINT_TOLERANCE = 24;

export type FrameSignature = Uint8Array;

export function frameSignature(rgba: ArrayLike<number>, width: number, height: number): FrameSignature {
  const out = new Uint8Array(GRID_W * GRID_H * 3);
  if (width < 2 || height < 2 || rgba.length < width * height * 4) return out;
  let o = 0;
  for (let gy = 0; gy < GRID_H; gy++) {
    const y = Math.min(height - 2, Math.floor(((gy + 0.5) * height) / GRID_H));
    for (let gx = 0; gx < GRID_W; gx++) {
      const x = Math.min(width - 2, Math.floor(((gx + 0.5) * width) / GRID_W));
      for (let c = 0; c < 3; c++) {
        const i0 = (y * width + x) * 4 + c;
        const i1 = i0 + 4;
        const i2 = i0 + width * 4;
        const i3 = i2 + 4;
        out[o++] = ((rgba[i0] ?? 0) + (rgba[i1] ?? 0) + (rgba[i2] ?? 0) + (rgba[i3] ?? 0)) >> 2;
      }
    }
  }
  return out;
}

/** Fraction (0..1) of grid points that differ between two signatures. */
export function signatureDiff(a: FrameSignature | null, b: FrameSignature | null): number {
  if (!a || !b || a.length !== b.length) return 1;
  let changed = 0;
  const points = a.length / 3;
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!);
    if (d > POINT_TOLERANCE) changed++;
  }
  return points ? changed / points : 0;
}

/**
 * True when the new frame shows different content. Any changed grid point
 * counts (a moving video, a typed character big enough to hit the grid);
 * identical keep-alive frames and repaints of excluded windows do not.
 */
export function contentChanged(prev: FrameSignature | null, next: FrameSignature): boolean {
  if (!prev) return true;
  return signatureDiff(prev, next) > 0;
}

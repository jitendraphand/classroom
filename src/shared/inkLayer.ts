/**
 * Overlay ink as a bitmap layer composited into published capture frames.
 *
 * Root cause (E2E 2026-10-09): ink lived only in a transparent, layered
 * BrowserWindow that was meant to be picked up by the monitor capture. In a
 * GPU-less / Remote Desktop session Chromium renders that window with
 * UpdateLayeredWindow, and Windows.Graphics.Capture's monitor texture did not
 * contain it, so students never saw the teacher's or their own strokes. The
 * annotation window now renders its canvas (teacher shapes, text, laser,
 * student strokes and name tags) at the published frame size and sends the
 * non-empty bounding box; main alpha-blends it into every frame. The overlay
 * window stays capture-visible (excluding a transparent layered window paints
 * black on Windows 10), so a desktop whose capture DOES contain it would show
 * the ink twice: `layerAlreadyInFrame` samples the opaque ink pixels and the
 * blend is skipped when the frame already shows them.
 *
 * `rgba` is straight (non-premultiplied) RGBA, as getImageData returns.
 */

export type InkLayer = {
  /** Frame size the layer was rendered for. */
  fw: number;
  fh: number;
  /** Bounding box of the non-transparent pixels inside that frame. */
  x: number;
  y: number;
  w: number;
  h: number;
  rgba: Uint8Array;
};

const MAX_SIDE = 4096;

export function parseInkLayer(raw: unknown): InkLayer | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ints = ['fw', 'fh', 'x', 'y', 'w', 'h'].map((k) => Number(r[k]));
  if (ints.some((n) => !Number.isInteger(n) || n < 0 || n > MAX_SIDE)) return null;
  const [fw, fh, x, y, w, h] = ints as [number, number, number, number, number, number];
  if (w === 0 || h === 0) return null; // empty: nothing to draw
  if (fw < 2 || fh < 2 || x + w > fw || y + h > fh) return null;
  let rgba: Uint8Array | null = null;
  if (r.rgba instanceof Uint8Array) rgba = r.rgba;
  else if (r.rgba instanceof Uint8ClampedArray) rgba = new Uint8Array(r.rgba.buffer, r.rgba.byteOffset, r.rgba.byteLength);
  else if (r.rgba instanceof ArrayBuffer) rgba = new Uint8Array(r.rgba);
  if (!rgba || rgba.length < w * h * 4) return null;
  return { fw, fh, x, y, w, h, rgba };
}

/** Blend `layer` over the frame in place. Skipped when the frame size differs from the layer's. */
export function compositeInkLayer(frame: Uint8Array, width: number, height: number, layer: InkLayer): boolean {
  if (layer.fw !== width || layer.fh !== height || frame.length < width * height * 4) return false;
  const src = layer.rgba;
  for (let row = 0; row < layer.h; row++) {
    let si = row * layer.w * 4;
    let di = ((layer.y + row) * width + layer.x) * 4;
    for (let col = 0; col < layer.w; col++, si += 4, di += 4) {
      const a = src[si + 3]!;
      if (a === 0) continue;
      if (a === 255) {
        frame[di] = src[si]!;
        frame[di + 1] = src[si + 1]!;
        frame[di + 2] = src[si + 2]!;
        continue;
      }
      const inv = 255 - a;
      frame[di] = (src[si]! * a + frame[di]! * inv + 127) / 255;
      frame[di + 1] = (src[si + 1]! * a + frame[di + 1]! * inv + 127) / 255;
      frame[di + 2] = (src[si + 2]! * a + frame[di + 2]! * inv + 127) / 255;
    }
  }
  return true;
}

/**
 * Crop an RGBA image to its non-transparent pixels (alpha > `minAlpha`).
 * Returns w=h=0 when nothing is drawn. Used by the overlay before the IPC hop.
 */
export function cropInk(rgba: Uint8Array | Uint8ClampedArray, fw: number, fh: number, minAlpha = 2): InkLayer {
  let minX = fw;
  let minY = fh;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < fh; y++) {
    let i = y * fw * 4 + 3;
    for (let x = 0; x < fw; x++, i += 4) {
      if (rgba[i]! > minAlpha) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { fw, fh, x: 0, y: 0, w: 0, h: 0, rgba: new Uint8Array(0) };
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const s = ((minY + row) * fw + minX) * 4;
    out.set(rgba.subarray(s, s + w * 4), row * w * 4);
  }
  return { fw, fh, x: minX, y: minY, w, h, rgba: out };
}

/** Per-channel sum tolerance when checking whether captured pixels already show the ink. */
export const PRESENT_TOLERANCE = 90;
const PRESENT_SAMPLES = 256;

/**
 * True when the captured frame already contains the overlay's ink (the WGC
 * texture included the layered window): most strongly opaque ink pixels match.
 * Translucent-only ink (highlighter) cannot be judged and returns false.
 */
export function layerAlreadyInFrame(frame: Uint8Array, width: number, height: number, layer: InkLayer): boolean {
  if (layer.fw !== width || layer.fh !== height) return false;
  const src = layer.rgba;
  const total = layer.w * layer.h;
  const step = Math.max(1, Math.floor(total / (PRESENT_SAMPLES * 8)));
  let checked = 0;
  let matched = 0;
  for (let p = 0; p < total && checked < PRESENT_SAMPLES; p += step) {
    const si = p * 4;
    if (src[si + 3]! < 230) continue;
    const x = layer.x + (p % layer.w);
    const y = layer.y + Math.floor(p / layer.w);
    const di = (y * width + x) * 4;
    checked++;
    const d = Math.abs(frame[di]! - src[si]!) + Math.abs(frame[di + 1]! - src[si + 1]!) + Math.abs(frame[di + 2]! - src[si + 2]!);
    if (d <= PRESENT_TOLERANCE) matched++;
  }
  return checked >= 8 && matched / checked >= 0.7;
}

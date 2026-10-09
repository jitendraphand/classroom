/**
 * Burn vector annotation strokes into a captured RGBA frame.
 *
 * Windows.Graphics.Capture does not always include a transparent layered
 * overlay, so the same shapes the overlay draws are composited here before
 * the frame is scored or published. Pixels that already match the stroke
 * are left alone, so a capture that already contains the overlay is not
 * drawn a second time. The buffer stays tightly packed RGBA.
 */

import type { AnnotShape } from './annotateOverlay';

export type InkMonitor = {
  /** CSS pixels to device pixels on the captured monitor. */
  scale: number;
  /** Physical size of that monitor. The frame may be a fitted copy of it. */
  monitorW: number;
  monitorH: number;
};

type Rgb = { r: number; g: number; b: number };

function parseColor(color: string): Rgb {
  const hex = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!hex) return { r: 239, g: 68, b: 68 };
  const n = Number.parseInt(hex[1]!, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function plot(rgba: Uint8Array, width: number, height: number, x: number, y: number, color: Rgb, opacity: number): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const i = (y * width + x) * 4;
  const a = opacity <= 0 ? 0 : opacity >= 1 ? 1 : opacity;
  if (a <= 0) return;
  const r = rgba[i] ?? 0;
  const g = rgba[i + 1] ?? 0;
  const b = rgba[i + 2] ?? 0;
  const nr = Math.round(r * (1 - a) + color.r * a);
  const ng = Math.round(g * (1 - a) + color.g * a);
  const nb = Math.round(b * (1 - a) + color.b * a);
  if (r === nr && g === ng && b === nb) return;
  rgba[i] = nr;
  rgba[i + 1] = ng;
  rgba[i + 2] = nb;
}

function strokeDisk(
  rgba: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  color: Rgb,
  opacity: number
): void {
  const r = Math.max(0.5, radius);
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - r));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1) + r));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - r));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1) + r));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const r2 = r * r;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let t = len2 === 0 ? 0 : ((px - x0) * dx + (py - y0) * dy) / len2;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const qx = x0 + t * dx - px;
      const qy = y0 + t * dy - py;
      if (qx * qx + qy * qy <= r2) plot(rgba, width, height, x, y, color, opacity);
    }
  }
}

function fillTriangle(
  rgba: Uint8Array,
  width: number,
  height: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  color: Rgb,
  opacity: number
): void {
  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
  const v0x = cx - ax;
  const v0y = cy - ay;
  const v1x = bx - ax;
  const v1y = by - ay;
  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot11 = v1x * v1x + v1y * v1y;
  const den = dot00 * dot11 - dot01 * dot01;
  if (den === 0) return;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const v2x = x + 0.5 - ax;
      const v2y = y + 0.5 - ay;
      const dot02 = v0x * v2x + v0y * v2y;
      const dot12 = v1x * v2x + v1y * v2y;
      const u = (dot11 * dot02 - dot01 * dot12) / den;
      const v = (dot00 * dot12 - dot01 * dot02) / den;
      if (u >= 0 && v >= 0 && u + v <= 1) plot(rgba, width, height, x, y, color, opacity);
    }
  }
}

function burnShape(
  rgba: Uint8Array,
  width: number,
  height: number,
  shape: AnnotShape,
  sx: number,
  sy: number,
  scale: number
): void {
  if (shape.type === 'text' || shape.points.length === 0) return;
  const color = parseColor(shape.color);
  const opacity = shape.opacity;
  const strokePx = Math.max(1, shape.width * (scale > 0 ? scale : 1) * ((sx + sy) / 2));
  const radius = strokePx / 2;
  const X = (p: [number, number]) => p[0] * width;
  const Y = (p: [number, number]) => p[1] * height;
  const seg = (a: [number, number], b: [number, number]) =>
    strokeDisk(rgba, width, height, X(a), Y(a), X(b), Y(b), radius, color, opacity);

  if (shape.type === 'rect' && shape.points.length >= 2) {
    const a = shape.points[0]!;
    const b = shape.points[shape.points.length - 1]!;
    const p00: [number, number] = [a[0], a[1]];
    const p10: [number, number] = [b[0], a[1]];
    const p11: [number, number] = [b[0], b[1]];
    const p01: [number, number] = [a[0], b[1]];
    seg(p00, p10);
    seg(p10, p11);
    seg(p11, p01);
    seg(p01, p00);
    return;
  }
  if (shape.type === 'ellipse' && shape.points.length >= 2) {
    const a = shape.points[0]!;
    const b = shape.points[shape.points.length - 1]!;
    const cx = ((a[0] + b[0]) / 2) * width;
    const cy = ((a[1] + b[1]) / 2) * height;
    const rx = Math.max(1, (Math.abs(b[0] - a[0]) / 2) * width);
    const ry = Math.max(1, (Math.abs(b[1] - a[1]) / 2) * height);
    const steps = Math.max(24, Math.ceil((rx + ry) / 4));
    let prev: [number, number] | null = null;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      const p: [number, number] = [(cx + Math.cos(t) * rx) / width, (cy + Math.sin(t) * ry) / height];
      if (prev) seg(prev, p);
      prev = p;
    }
    return;
  }
  if (shape.type === 'arrow' && shape.points.length >= 2) {
    const a = shape.points[0]!;
    const b = shape.points[shape.points.length - 1]!;
    seg(a, b);
    const x0 = X(a);
    const y0 = Y(a);
    const x1 = X(b);
    const y1 = Y(b);
    const ang = Math.atan2(y1 - y0, x1 - x0);
    const len = Math.max(10 * ((sx + sy) / 2), strokePx * 4);
    const p1x = x1 + Math.cos(ang + Math.PI * 0.85) * len;
    const p1y = y1 + Math.sin(ang + Math.PI * 0.85) * len;
    const p2x = x1 + Math.cos(ang - Math.PI * 0.85) * len;
    const p2y = y1 + Math.sin(ang - Math.PI * 0.85) * len;
    fillTriangle(rgba, width, height, x1, y1, p1x, p1y, p2x, p2y, color, opacity);
    return;
  }
  for (let i = 1; i < shape.points.length; i++) seg(shape.points[i - 1]!, shape.points[i]!);
  if (shape.points.length === 1) seg(shape.points[0]!, shape.points[0]!);
}

/** Draw `shapes` into `rgba`. Coordinates are 0–1 of the captured monitor. */
export function burnShapesIntoFrame(
  rgba: Uint8Array,
  width: number,
  height: number,
  shapes: readonly AnnotShape[],
  monitor: InkMonitor
): void {
  if (width < 2 || height < 2 || rgba.length < width * height * 4 || shapes.length === 0) return;
  const monW = monitor.monitorW > 0 ? monitor.monitorW : width;
  const monH = monitor.monitorH > 0 ? monitor.monitorH : height;
  const sx = width / monW;
  const sy = height / monH;
  for (const shape of shapes) burnShape(rgba, width, height, shape, sx, sy, monitor.scale);
}

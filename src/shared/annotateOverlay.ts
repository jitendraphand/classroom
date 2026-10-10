/**
 * Vector annotations for the transparent overlay.
 *
 * Coordinates are 0–1 of the shared monitor's physical pixel size, so a point
 * stays put when the host is at 100%, 125%, 150%, 175%, or 200%, and when a
 * remote observer uses a different resolution. The overlay window is not
 * capture-excluded: its strokes are in the picture. Opaque classroom windows are.
 */

import { quantize, strokeHit, type AnnotateMsg, type AnnotateStroke, type Pt } from './annotate';

export const OVERLAY_TOOLS = ['pen', 'arrow', 'line', 'rect', 'ellipse', 'text', 'highlight', 'laser', 'eraser'] as const;
export type OverlayTool = (typeof OVERLAY_TOOLS)[number];
export type ShapeType = 'pen' | 'arrow' | 'line' | 'rect' | 'ellipse' | 'text' | 'highlight';

export type AnnotShape = {
  id: string;
  type: ShapeType;
  /** Normalised to the monitor: x / screenWidthPx, y / screenHeightPx. */
  points: Pt[];
  color: string;
  /** Pen size in CSS pixels. The canvas scales it by the monitor DPI. */
  width: number;
  opacity: number;
  text: string;
  timestamp: number;
};

export type PhysicalMonitor = { x: number; y: number; widthPx: number; heightPx: number };
export type DipBox = { x: number; y: number; w: number; h: number };

export type AnnotateCommand =
  | { op: 'tool'; tool: OverlayTool }
  | { op: 'color'; color: string }
  /** Pen size in CSS px (the highlighter and text scale from it). */
  | { op: 'width'; width: number }
  | { op: 'undo' }
  | { op: 'redo' }
  | { op: 'clear' }
  | { op: 'remote'; msg: unknown };

/** `students`: student strokes on the share (the teacher can erase/clear them). */
export type AnnotateStatus = { canUndo: boolean; canRedo: boolean; count: number; students?: number };

export function isOverlayTool(v: unknown): v is OverlayTool {
  return typeof v === 'string' && (OVERLAY_TOOLS as readonly string[]).includes(v);
}

const SHAPE_TYPES: readonly ShapeType[] = ['pen', 'arrow', 'line', 'rect', 'ellipse', 'text', 'highlight'];

export function defaultWidth(tool: OverlayTool): number {
  if (tool === 'highlight') return 22;
  if (tool === 'text') return 22;
  return 3;
}

/** Thickness slider (1..12, pen px) → the size a tool really uses. */
export const THICKNESS_MIN = 1;
export const THICKNESS_MAX = 12;
export function toolWidth(tool: OverlayTool, thickness: number): number {
  const t = Math.min(THICKNESS_MAX, Math.max(THICKNESS_MIN, Math.round(thickness) || 3));
  if (tool === 'highlight') return t * 6 + 4;
  if (tool === 'text') return 12 + t * 3;
  return t;
}

export function defaultOpacity(tool: OverlayTool): number {
  return tool === 'highlight' ? 0.35 : 1;
}

/**
 * CSS pointer → 0–1 of the monitor's physical pixels.
 * `windowDip` is the overlay bounds. `scale` is device pixels per DIP on that
 * monitor. `monitor` is the same screen in physical pixels (origin may be negative).
 *
 * The virtual-screen DIP origin is not multiplied by this monitor's scale.
 * A 150% display beside a 100% display starts at the primary's physical edge,
 * not at dipOrigin × 1.5. The pointer is converted to device pixels, then
 * placed inside the physical rectangle `dipToScreenRect` already computed.
 */
export function cssPointerToNormalized(
  client: { x: number; y: number },
  windowDip: DipBox,
  scale: number,
  monitor: PhysicalMonitor
): Pt | null {
  if (
    !Number.isFinite(client.x) ||
    !Number.isFinite(client.y) ||
    !(windowDip.w > 0) ||
    !(windowDip.h > 0) ||
    !(scale > 0) ||
    !(monitor.widthPx > 0) ||
    !(monitor.heightPx > 0)
  ) {
    return null;
  }
  const spanX = windowDip.w * scale;
  const spanY = windowDip.h * scale;
  const physX = monitor.x + ((client.x * scale) / spanX) * monitor.widthPx;
  const physY = monitor.y + ((client.y * scale) / spanY) * monitor.heightPx;
  return quantize([(physX - monitor.x) / monitor.widthPx, (physY - monitor.y) / monitor.heightPx]);
}

/** Remote observer pixel on their copy of the same monitor, into the shared 0–1 space. */
export function normalizePhysical(x: number, y: number, screenWidthPx: number, screenHeightPx: number): Pt | null {
  if (!(screenWidthPx > 0) || !(screenHeightPx > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return quantize([x / screenWidthPx, y / screenHeightPx]);
}

export function shapeFromStroke(stroke: AnnotateStroke, timestamp = 0): AnnotShape {
  const highlight = stroke.tool === 'highlighter';
  return {
    id: stroke.id,
    type: highlight ? 'highlight' : 'pen',
    points: stroke.points.map((p) => quantize(p)),
    color: stroke.color,
    width: stroke.width,
    opacity: highlight ? 0.35 : 1,
    text: '',
    timestamp,
  };
}

function isPt(v: unknown): v is Pt {
  return Array.isArray(v) && v.length >= 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]);
}

export function parseShape(raw: unknown): AnnotShape | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== 'string' || !s.id) return null;
  if (typeof s.type !== 'string' || !(SHAPE_TYPES as readonly string[]).includes(s.type)) return null;
  if (!Array.isArray(s.points) || !s.points.every(isPt)) return null;
  const width = typeof s.width === 'number' && s.width > 0 ? s.width : defaultWidth(s.type as OverlayTool);
  const opacity = typeof s.opacity === 'number' ? Math.min(1, Math.max(0, s.opacity)) : defaultOpacity(s.type as OverlayTool);
  return {
    id: s.id,
    type: s.type as ShapeType,
    points: (s.points as Pt[]).map((p) => quantize(p)),
    color: typeof s.color === 'string' && s.color ? s.color : '#ef4444',
    width,
    opacity,
    text: typeof s.text === 'string' ? s.text.slice(0, 500) : '',
    timestamp: typeof s.timestamp === 'number' ? s.timestamp : 0,
  };
}

/** Undo stack stores the document before each change, so redo can put it back. */
export class ShapeLog {
  shapes: AnnotShape[] = [];
  private undoStack: AnnotShape[][] = [];
  private redoStack: AnnotShape[][] = [];

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  status(): AnnotateStatus {
    return { canUndo: this.canUndo, canRedo: this.canRedo, count: this.shapes.length };
  }

  reset(shapes: AnnotShape[]): void {
    this.shapes = shapes.map(cloneShape);
    this.undoStack = [];
    this.redoStack = [];
  }

  add(shape: AnnotShape): void {
    if (this.shapes.some((s) => s.id === shape.id)) return;
    this.commit([...this.shapes, cloneShape(shape)]);
  }

  /** Append points onto an existing stroke (a remote pen still being drawn). */
  extend(id: string, points: Pt[]): void {
    const shape = this.shapes.find((s) => s.id === id);
    if (!shape || !points.length) return;
    const next = this.shapes.map((s) =>
      s.id === id ? { ...s, points: [...s.points, ...points.map((p) => quantize(p))] } : s
    );
    this.commit(next);
  }

  erase(ids: readonly string[]): void {
    const drop = new Set(ids);
    if (!this.shapes.some((s) => drop.has(s.id))) return;
    this.commit(this.shapes.filter((s) => !drop.has(s.id)));
  }

  clear(): void {
    if (!this.shapes.length) return;
    this.commit([]);
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.shapes);
    this.shapes = prev;
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.shapes);
    this.shapes = next;
    return true;
  }

  private commit(next: AnnotShape[]): void {
    this.undoStack.push(this.shapes);
    this.redoStack = [];
    this.shapes = next;
  }
}

function cloneShape(s: AnnotShape): AnnotShape {
  return { ...s, points: s.points.map((p) => [p[0], p[1]] as Pt) };
}

export function shapesHit(shapes: readonly AnnotShape[], p: Pt, aspect = 1): string[] {
  return shapes.filter((s) => shapeHit(s, p, aspect)).map((s) => s.id);
}

export function shapeHit(shape: AnnotShape, p: Pt, aspect = 1): boolean {
  if (shape.type === 'text') return textHit(shape, p);
  if (shape.type === 'rect') return rectHit(shape, p, aspect);
  if (shape.type === 'ellipse') return ellipseHit(shape, p);
  return strokeHit({ id: shape.id, width: shape.width, points: shape.points }, p, aspect);
}

function textHit(shape: AnnotShape, p: Pt): boolean {
  const anchor = shape.points[0];
  if (!anchor || !shape.text) return false;
  const width = Math.max(0.02, shape.text.length * 0.012);
  const height = 0.04;
  return p[0] >= anchor[0] && p[0] <= anchor[0] + width && p[1] >= anchor[1] - height && p[1] <= anchor[1] + 0.01;
}

function rectHit(shape: AnnotShape, p: Pt, aspect: number): boolean {
  const a = shape.points[0];
  const b = shape.points[1] ?? a;
  if (!a || !b) return false;
  const left = Math.min(a[0], b[0]);
  const right = Math.max(a[0], b[0]);
  const top = Math.min(a[1], b[1]);
  const bottom = Math.max(a[1], b[1]);
  const corners: Pt[] = [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
    [left, top],
  ];
  return strokeHit({ id: shape.id, width: shape.width, points: corners }, p, aspect);
}

function ellipseHit(shape: AnnotShape, p: Pt): boolean {
  const a = shape.points[0];
  const b = shape.points[1] ?? a;
  if (!a || !b) return false;
  const rx = Math.max(0.004, Math.abs(b[0] - a[0]) / 2);
  const ry = Math.max(0.004, Math.abs(b[1] - a[1]) / 2);
  const cx = (a[0] + b[0]) / 2;
  const cy = (a[1] + b[1]) / 2;
  const nx = (p[0] - cx) / rx;
  const ny = (p[1] - cy) / ry;
  const d = Math.hypot(nx, ny);
  return Math.abs(d - 1) <= 0.18;
}

function screenOf(msg: Record<string, unknown>): { w: number; h: number } | null {
  const w = msg.screenWidthPx;
  const h = msg.screenHeightPx;
  if (typeof w !== 'number' || typeof h !== 'number' || !(w > 0) || !(h > 0)) return null;
  return { w, h };
}

function mapRawPoint(v: unknown, screen: { w: number; h: number }): Pt | null {
  if (!Array.isArray(v) || v.length < 2 || !Number.isFinite(Number(v[0])) || !Number.isFinite(Number(v[1]))) return null;
  return normalizePhysical(Number(v[0]), Number(v[1]), screen.w, screen.h);
}

function mapRawPoints(v: unknown, screen: { w: number; h: number }): Pt[] | null {
  if (!Array.isArray(v)) return null;
  const out: Pt[] = [];
  for (const item of v) {
    const p = mapRawPoint(item, screen);
    if (!p) return null;
    out.push(p);
  }
  return out;
}

/**
 * When the observer sends physical pixels plus the captured monitor size,
 * convert them with x / screenWidthPx before they are stored as 0–1.
 * Packets without those fields are already in the shared 0–1 space.
 */
function withNormalizedPixels(msg: Record<string, unknown>): Record<string, unknown> | null {
  const screen = screenOf(msg);
  if (!screen) return msg;
  const type = msg.type;
  if (type === 'shape' && msg.shape && typeof msg.shape === 'object') {
    const shape = { ...(msg.shape as Record<string, unknown>) };
    const points = mapRawPoints(shape.points, screen);
    if (!points) return null;
    shape.points = points;
    return { ...msg, shape };
  }
  if (type === 'shapes' && Array.isArray(msg.shapes)) {
    const shapes = [];
    for (const item of msg.shapes) {
      if (!item || typeof item !== 'object') return null;
      const shape = { ...(item as Record<string, unknown>) };
      const points = mapRawPoints(shape.points, screen);
      if (!points) return null;
      shape.points = points;
      shapes.push(shape);
    }
    return { ...msg, shapes };
  }
  if (type === 'begin' && msg.stroke && typeof msg.stroke === 'object') {
    const stroke = { ...(msg.stroke as Record<string, unknown>) };
    const points = mapRawPoints(stroke.points, screen);
    if (!points) return null;
    stroke.points = points;
    return { ...msg, stroke };
  }
  if (type === 'point') {
    const p = mapRawPoint(msg.p, screen);
    if (!p) return null;
    return { ...msg, p };
  }
  if (type === 'points') {
    const pts = mapRawPoints(msg.pts, screen);
    if (!pts) return null;
    return { ...msg, pts };
  }
  if (type === 'snapshot' && Array.isArray(msg.strokes)) {
    const strokes = [];
    for (const item of msg.strokes) {
      if (!item || typeof item !== 'object') return null;
      const stroke = { ...(item as Record<string, unknown>) };
      const points = mapRawPoints(stroke.points, screen);
      if (!points) return null;
      stroke.points = points;
      strokes.push(stroke);
    }
    return { ...msg, strokes };
  }
  return msg;
}

/**
 * Apply one observer packet. Legacy classroom strokes (pen / highlighter)
 * become vector shapes. The host draws them; it does not publish them again.
 */
export function applyRemoteMessage(log: ShapeLog, raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const incoming = raw as Record<string, unknown>;
  if (incoming.v !== 1 || typeof incoming.type !== 'string') return false;
  const normalized = withNormalizedPixels(incoming);
  if (!normalized) return false;
  const msg = normalized;
  if (msg.type === 'shape') {
    const shape = parseShape(msg.shape);
    if (!shape) return false;
    const before = log.shapes.length;
    log.add(shape);
    return log.shapes.length !== before;
  }
  if (msg.type === 'shapes' && Array.isArray(msg.shapes)) {
    let changed = false;
    for (const item of msg.shapes) {
      const shape = parseShape(item);
      if (!shape) continue;
      const before = log.shapes.length;
      log.add(shape);
      changed = changed || log.shapes.length !== before;
    }
    return changed;
  }
  return applyLegacy(log, msg as AnnotateMsg);
}

function applyLegacy(log: ShapeLog, msg: AnnotateMsg): boolean {
  if (msg.type === 'begin' && msg.stroke) {
    const before = log.shapes.length;
    log.add(shapeFromStroke(msg.stroke));
    return log.shapes.length !== before;
  }
  if (msg.type === 'point' || msg.type === 'points') {
    const pts = msg.type === 'point' ? [msg.p] : msg.pts;
    if (!log.shapes.some((s) => s.id === msg.id)) return false;
    log.extend(msg.id, pts);
    return true;
  }
  if (msg.type === 'erase') {
    const before = log.shapes.length;
    log.erase(msg.ids);
    return log.shapes.length !== before;
  }
  if (msg.type === 'clear') {
    const before = log.shapes.length;
    log.clear();
    return before > 0;
  }
  if (msg.type === 'undo') {
    const before = log.shapes.length;
    log.erase([msg.id]);
    return log.shapes.length !== before;
  }
  if (msg.type === 'snapshot') {
    log.reset(msg.strokes.map((s, i) => shapeFromStroke(s, i)));
    return true;
  }
  return false;
}

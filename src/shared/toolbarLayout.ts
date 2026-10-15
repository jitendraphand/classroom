/**
 * Annotate toolbar layout (pure): grouped tools, tooltips with shortcuts and
 * the window size for each dock orientation.
 */
import type { OverlayTool } from './annotateOverlay';

export type ToolbarOrient = 'horizontal' | 'vertical';

export type ToolDef = { id: OverlayTool; label: string; icon: string; key: string };

export const TOOL_GROUPS: { id: string; label: string; tools: ToolDef[] }[] = [
  {
    id: 'draw',
    label: 'Draw',
    tools: [
      { id: 'pen', label: 'Pen', icon: 'pen', key: 'P' },
      { id: 'highlight', label: 'Highlighter', icon: 'highlighter', key: 'H' },
      { id: 'eraser', label: 'Eraser (also removes student strokes)', icon: 'eraser', key: 'E' },
    ],
  },
  {
    id: 'shapes',
    label: 'Shapes',
    tools: [
      { id: 'line', label: 'Line', icon: 'line', key: 'L' },
      { id: 'arrow', label: 'Arrow', icon: 'arrow', key: 'A' },
      { id: 'rect', label: 'Rectangle', icon: 'rect', key: 'R' },
      { id: 'ellipse', label: 'Ellipse', icon: 'ellipse', key: 'O' },
    ],
  },
  {
    id: 'point',
    label: 'Text and laser',
    tools: [
      { id: 'text', label: 'Text', icon: 'text', key: 'T' },
      { id: 'laser', label: 'Laser pointer', icon: 'laser', key: 'K' },
    ],
  },
];

export const ALL_TOOLS: ToolDef[] = TOOL_GROUPS.flatMap((g) => g.tools);

export function toolForKey(key: string): ToolDef | undefined {
  const k = key.toUpperCase();
  return ALL_TOOLS.find((t) => t.key === k);
}

/** Tooltip text: "Pen (P)". */
export function tip(label: string, shortcut?: string): string {
  return shortcut ? `${label} (${shortcut})` : label;
}

/** Hit targets: 36 px buttons (was 28-30). */
export const BUTTON_PX = 36;

/** Initial window size before the panel has measured its content. */
export function toolbarSize(orient: ToolbarOrient): { width: number; height: number } {
  return orient === 'vertical' ? { width: 64, height: 560 } : { width: 1040, height: 60 };
}

export type Rect = { x: number; y: number; width: number; height: number };

/** Keep a window fully inside a work area (any edge). Oversized windows pin to the top-left. */
export function clampToArea(b: Rect, area: Rect): Rect {
  const width = Math.min(b.width, area.width);
  const height = Math.min(b.height, area.height);
  const x = Math.round(Math.min(Math.max(area.x, b.x), area.x + area.width - width));
  const y = Math.round(Math.min(Math.max(area.y, b.y), area.y + area.height - height));
  return { x, y, width: Math.round(width), height: Math.round(height) };
}

/**
 * Size the annotate panel to its content (trial 2026-10-14: the vertical
 * window was a fixed 64x720 and clipped Undo … Stop annotating). `natural` is
 * one line of tools (a column when vertical, a row when horizontal). When the
 * line does not fit the work area it wraps into more lines (2 columns, …);
 * `extraLines` adds lines when the panel reports it still overflows.
 * Result is clamped inside `area` (DIP; the same at 100/125/150 %).
 */
export function fitToolbar(
  orient: ToolbarOrient,
  natural: { width: number; height: number },
  area: Rect,
  pos: { x: number; y: number },
  extraLines = 0
): Rect & { lines: number } {
  const nw = Math.max(40, Math.ceil(natural.width));
  const nh = Math.max(40, Math.ceil(natural.height));
  if (orient === 'vertical') {
    const lines = Math.max(1, Math.ceil(nh / Math.max(1, area.height))) + Math.max(0, extraLines);
    const height = lines === 1 ? nh : Math.min(area.height, Math.ceil(nh / lines) + 120);
    return { ...clampToArea({ x: pos.x, y: pos.y, width: nw * lines, height }, area), lines };
  }
  const lines = Math.max(1, Math.ceil(nw / Math.max(1, area.width))) + Math.max(0, extraLines);
  const width = lines === 1 ? nw : Math.min(area.width, Math.ceil(nw / lines) + 160);
  return { ...clampToArea({ x: pos.x, y: pos.y, width, height: nh * lines }, area), lines };
}

/**
 * Measured content size with hysteresis: a re-measure within `tol` px of the
 * previous one keeps the previous size. Every drag re-measured the panel and
 * the +2 px slack (plus DPI rounding at 125/150 %) fed back into the window
 * width, so the vertical toolbar crept 132 -> 137 px over repeated drags.
 */
export function stableNatural(
  prev: { width: number; height: number } | null,
  next: { width: number; height: number },
  tol = 4
): { width: number; height: number } {
  if (prev && Math.abs(prev.width - next.width) <= tol && Math.abs(prev.height - next.height) <= tol) return prev;
  return next;
}

/**
 * Bounds after a drag: keep the FIXED size the layout chose (never the size
 * Windows reports back, which can be a DIP rounding step larger) and only
 * clamp the position into the work area.
 */
export function movedBounds(b: Rect, fixed: { width: number; height: number } | null, area: Rect): Rect {
  const size = fixed ?? { width: b.width, height: b.height };
  return clampToArea({ x: b.x, y: b.y, width: size.width, height: size.height }, area);
}

export function parseOrient(v: unknown): ToolbarOrient {
  return v === 'vertical' ? 'vertical' : 'horizontal';
}

/**
 * Pure geometry for draggable floating panels (FloatingPanel.tsx), unit-tested
 * in tests/floatGeometry.test.ts.
 */
export type FloatPos = { x: number; y: number };
export type FloatSize = { w: number; h: number };
/** Space kept clear at the viewport edges (e.g. the teacher header on top). */
export type FloatInsets = { top: number; right: number; bottom: number; left: number };

export const FLOAT_MARGIN = 4;

/**
 * Keep a panel inside the viewport (minus insets). When the panel is larger
 * than the free area it is pinned to the top/left edge so its header (the drag
 * handle) always stays reachable.
 */
export function clampFloat(pos: FloatPos, size: FloatSize, viewport: FloatSize, insets: Partial<FloatInsets> = {}): FloatPos {
  const t = (insets.top ?? 0) + FLOAT_MARGIN;
  const l = (insets.left ?? 0) + FLOAT_MARGIN;
  const r = viewport.w - (insets.right ?? 0) - FLOAT_MARGIN;
  const b = viewport.h - (insets.bottom ?? 0) - FLOAT_MARGIN;
  const maxX = Math.max(l, r - size.w);
  const maxY = Math.max(t, b - size.h);
  const x = Number.isFinite(pos.x) ? pos.x : l;
  const y = Number.isFinite(pos.y) ? pos.y : t;
  return { x: Math.round(Math.min(maxX, Math.max(l, x))), y: Math.round(Math.min(maxY, Math.max(t, y))) };
}

/** Moved far enough to count as a drag (so a tap on the header stays a tap). */
export function isDrag(dx: number, dy: number, threshold = 4): boolean {
  return dx * dx + dy * dy >= threshold * threshold;
}

export function parseStoredPos(raw: string | null): FloatPos | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (typeof v.x === 'number' && typeof v.y === 'number' && Number.isFinite(v.x) && Number.isFinite(v.y)) {
      return { x: v.x, y: v.y };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Screen-share controls placement. A monitor ("entire screen") capture records
 * every window on that screen, including the always-on-top Picture-in-Picture
 * controls and the pop-up fallback, so those are only used for window/tab
 * captures; a monitor capture gets the controls inside the classroom tab.
 * Unknown surface (browser does not report it) keeps the floating window.
 */
export function shareControlsPlacement(displaySurface: string | undefined | null): 'floating' | 'inline' {
  return displaySurface === 'monitor' ? 'inline' : 'floating';
}

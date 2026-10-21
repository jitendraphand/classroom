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
 * Unknown surface is treated as a monitor (fail closed).
 */
export function showLocalSharePreview(displaySurface: string | undefined | null): boolean {
  // Only a window or tab capture is safe to play back on the teacher's own
  // stage. A monitor capture records the stage itself (an endless tunnel), and
  // an unknown surface might be a monitor.
  return displaySurface === 'window' || displaySurface === 'browser';
}

export function shareControlsPlacement(displaySurface: string | undefined | null): 'floating' | 'inline' {
  // Unknown counts as a monitor: fail closed (callers normally resolve it
  // first with surfaceFromTrack, which also reads the track label).
  return displaySurface === 'window' || displaySurface === 'browser' ? 'floating' : 'inline';
}

/**
 * Whiteboard tool column (WhiteboardBoard `barW`). Floats must start to the
 * right of this, or they cover the pen / eraser / colour buttons.
 */
export const WB_TOOL_COLUMN_PX = 54;
/** Column plus a gap, so a panel edge does not sit on the tool buttons. */
export const WB_TOOL_CLEAR_PX = WB_TOOL_COLUMN_PX + 8;
/** Compact whiteboard video may cover at most this fraction of the board. */
export const WB_VIDEO_MAX_AREA = 0.2;

export type FloatRect = { x: number; y: number; w: number; h: number };

const WB_HEADER = 34;
const WB_PAD = 16;
const WB_GAP = 6;
const WB_BORDER = 2;

export function parseStoredSize(raw: string | null): { w: number; h: number } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { w?: unknown; h?: unknown };
    if (
      typeof v.w === 'number' &&
      typeof v.h === 'number' &&
      v.w > 0 &&
      v.h > 0 &&
      Number.isFinite(v.w) &&
      Number.isFinite(v.h)
    ) {
      return { w: v.w, h: v.h };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Push a saved video panel back onto the board: right of the tool column,
 * inside the board, and (when `maxAreaFraction` is set) no larger than that
 * share of the board. A saved full-screen box from an older session cannot
 * come back covering the tools.
 */
export function clampWhiteboardFloat(
  box: FloatRect,
  board: FloatRect,
  opts: { toolClear?: number; maxAreaFraction?: number; margin?: number } = {}
): FloatRect {
  const toolClear = opts.toolClear ?? WB_TOOL_CLEAR_PX;
  const margin = opts.margin ?? 8;
  const minX = board.x + toolClear;
  const minY = board.y + margin;
  const maxR = board.x + board.w - margin;
  const maxB = board.y + board.h - margin;
  const availW = Math.max(80, maxR - minX);
  const availH = Math.max(48, maxB - minY);
  let w = Number.isFinite(box.w) && box.w > 0 ? box.w : 160;
  let h = Number.isFinite(box.h) && box.h > 0 ? box.h : 120;
  if (w > availW || h > availH) {
    const s = Math.min(availW / w, availH / h, 1);
    w *= s;
    h *= s;
  }
  if (opts.maxAreaFraction && opts.maxAreaFraction > 0 && board.w > 0 && board.h > 0) {
    const cap = board.w * board.h * opts.maxAreaFraction;
    if (w * h > cap) {
      const s = Math.sqrt(cap / (w * h));
      w *= s;
      h *= s;
    }
  }
  w = Math.max(80, Math.min(availW, w));
  h = Math.max(48, Math.min(availH, h));
  let x = Number.isFinite(box.x) ? box.x : minX;
  let y = Number.isFinite(box.y) ? box.y : minY;
  x = Math.min(Math.max(minX, x), Math.max(minX, maxR - w));
  y = Math.min(Math.max(minY, y), Math.max(minY, maxB - h));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** Two stacked tiles, bottom-right, at most ~20% of the board, clear of the tools. */
export function compactWhiteboardVideo(board: FloatRect, toolClear = WB_TOOL_CLEAR_PX): FloatRect {
  const margin = 8;
  const maxW = Math.max(120, board.w - toolClear - margin);
  const maxH = Math.max(90, board.h - margin);
  const maxArea = Math.max(1, board.w * board.h * WB_VIDEO_MAX_AREA);
  const measure = (tw: number) => {
    const tileH = Math.max(36, Math.round((tw * 9) / 16));
    const paneW = WB_BORDER + WB_PAD + tw;
    const paneH = WB_HEADER + WB_PAD + tileH * 2 + WB_GAP;
    return { paneW, paneH, tileW: tw, area: paneW * paneH };
  };
  let tileW = Math.min(168, Math.max(72, maxW - WB_BORDER - WB_PAD));
  let m = measure(tileW);
  for (let i = 0; i < 80 && (m.area > maxArea || m.paneW > maxW || m.paneH > maxH) && tileW > 72; i++) {
    tileW -= 2;
    m = measure(tileW);
  }
  return clampWhiteboardFloat(
    { x: board.x + board.w - m.paneW - margin, y: board.y + board.h - m.paneH - margin, w: m.paneW, h: m.paneH },
    board,
    { toolClear, maxAreaFraction: WB_VIDEO_MAX_AREA, margin }
  );
}

/**
 * Geometry used when the whiteboard video panel opens. A saved box is kept
 * only after it has been clamped off the tools and down to the compact area,
 * so a previous 4/6-tile size cannot come back covering the board.
 */
export function placeWhiteboardVideo(
  storedPos: FloatPos | null,
  storedSize: { w: number; h: number } | null,
  board: FloatRect,
  toolClear = WB_TOOL_CLEAR_PX
): FloatRect {
  const compact = compactWhiteboardVideo(board, toolClear);
  return clampWhiteboardFloat(
    {
      x: storedPos?.x ?? compact.x,
      y: storedPos?.y ?? compact.y,
      w: storedSize?.w ?? compact.w,
      h: storedSize?.h ?? compact.h,
    },
    board,
    { toolClear, maxAreaFraction: WB_VIDEO_MAX_AREA }
  );
}

/** Smallest useful floating video panel: header plus one short tile. */
export const VIDEO_PANEL_MIN_W = 180;
export const VIDEO_PANEL_MIN_H = 132;
/** Gap kept between a resized video panel and the viewport edges. */
export const VIDEO_PANEL_MARGIN = 8;

export type VideoPanelClampOpts = {
  minW?: number;
  minH?: number;
  margin?: number;
  insets?: Partial<FloatInsets>;
};

/**
 * Clamp a floating video-panel size into the free viewport (minus insets and
 * margin). A saved or dragged size cannot cover the header, the tool column,
 * or the control bar, and cannot shrink past a usable tile — unless the
 * viewport itself is smaller, in which case the minimum shrinks to fit.
 */
export function clampVideoPanelSize(
  size: { w: number; h: number },
  viewport: { w: number; h: number },
  opts: VideoPanelClampOpts = {}
): { w: number; h: number } {
  const margin = opts.margin ?? VIDEO_PANEL_MARGIN;
  const insets = opts.insets ?? {};
  const vw = Number.isFinite(viewport.w) ? viewport.w : 0;
  const vh = Number.isFinite(viewport.h) ? viewport.h : 0;
  const left = Math.max(0, insets.left ?? 0);
  const right = Math.max(0, insets.right ?? 0);
  const top = Math.max(0, insets.top ?? 0);
  const bottom = Math.max(0, insets.bottom ?? 0);
  const availW = vw - left - right - margin * 2;
  const availH = vh - top - bottom - margin * 2;
  const maxW = Math.max(1, Math.floor(availW));
  const maxH = Math.max(1, Math.floor(availH));
  const minW = Math.min(opts.minW ?? VIDEO_PANEL_MIN_W, maxW);
  const minH = Math.min(opts.minH ?? VIDEO_PANEL_MIN_H, maxH);
  const w0 = Number.isFinite(size.w) && size.w > 0 ? size.w : minW;
  const h0 = Number.isFinite(size.h) && size.h > 0 ? size.h : minH;
  return {
    w: Math.round(Math.min(maxW, Math.max(minW, w0))),
    h: Math.round(Math.min(maxH, Math.max(minH, h0))),
  };
}

/** Size after a pointer drag of the bottom-right handle, then clamped. */
export function videoPanelSizeFromDrag(
  start: { w: number; h: number },
  dx: number,
  dy: number,
  viewport: { w: number; h: number },
  opts?: VideoPanelClampOpts
): { w: number; h: number } {
  return clampVideoPanelSize(
    {
      w: start.w + (Number.isFinite(dx) ? dx : 0),
      h: start.h + (Number.isFinite(dy) ? dy : 0),
    },
    viewport,
    opts
  );
}

/** Tile size that fits a pane of `cols` × `rows` (16:9), used by the compact grid. */
export function tilesInPane(paneW: number, paneH: number, cols: number, rows: number): { tileW: number; tileH: number } {
  const innerW = Math.max(32, paneW - WB_BORDER - WB_PAD - WB_GAP * Math.max(0, cols - 1));
  const innerH = Math.max(32, paneH - WB_HEADER - WB_PAD - WB_GAP * Math.max(0, rows - 1));
  let tileW = Math.floor(innerW / Math.max(1, cols));
  let tileH = Math.floor((tileW * 9) / 16);
  if (tileH * rows > innerH) {
    tileH = Math.floor(innerH / Math.max(1, rows));
    tileW = Math.floor((tileH * 16) / 9);
  }
  return { tileW: Math.max(48, tileW), tileH: Math.max(27, tileH) };
}

/**
 * In-tab share controls while the whiteboard is up: top-centre, never overlapping
 * the left tool column. `topInset` is the teacher header height.
 */
export function whiteboardShareDockPos(
  dock: { w: number; h: number },
  viewport: FloatSize,
  topInset: number,
  toolClear = WB_TOOL_CLEAR_PX
): FloatPos {
  const board: FloatRect = {
    x: 0,
    y: Math.max(0, topInset),
    w: viewport.w,
    h: Math.max(1, viewport.h - Math.max(0, topInset)),
  };
  const placed = clampWhiteboardFloat(
    { x: Math.round((viewport.w - dock.w) / 2), y: board.y + 8, w: Math.max(80, dock.w), h: Math.max(36, dock.h) },
    board,
    { toolClear, margin: 8 }
  );
  return { x: placed.x, y: placed.y };
}

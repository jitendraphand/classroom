/**
 * Teacher class home (no share, no whiteboard): the stage is one grid of the
 * teacher's tile and the students on the current video page. Pick the column
 * count that gives the largest 16:9 tiles inside the stage. Pure, unit-tested.
 */
export type FillGrid = { cols: number; rows: number; tileW: number; tileH: number; paneW: number; paneH: number; gap: number };

export const FILL_GRID_GAP = 8;
export const FILL_GRID_PAD = 8;
/** Header row of the grid (pager). */
export const FILL_GRID_HEADER = 36;

export function fillGridLayout(count: number, width: number, height: number, opts: { gap?: number; pad?: number; header?: number } = {}): FillGrid {
  const gap = opts.gap ?? FILL_GRID_GAP;
  const pad = opts.pad ?? FILL_GRID_PAD;
  const header = opts.header ?? FILL_GRID_HEADER;
  const n = Math.max(1, Math.floor(count));
  const W = Math.max(0, width);
  const H = Math.max(0, height);
  let best: FillGrid = { cols: 1, rows: n, tileW: 0, tileH: 0, paneW: W, paneH: H, gap };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const availW = W - 2 * pad - (cols - 1) * gap;
    const availH = H - header - 2 * pad - (rows - 1) * gap;
    if (availW <= 0 || availH <= 0) continue;
    const tileW = Math.floor(Math.min(availW / cols, ((availH / rows) * 16) / 9));
    if (tileW > best.tileW) best = { cols, rows, tileW, tileH: Math.floor((tileW * 9) / 16), paneW: W, paneH: H, gap };
  }
  return best;
}

/** Share / whiteboard window: 2 → 4 → 6 → 2 tiles (one is the teacher). */
export function nextOverlaySlots(n: 2 | 4 | 6): 2 | 4 | 6 {
  return n === 2 ? 4 : n === 4 ? 6 : 2;
}

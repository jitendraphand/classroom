/**
 * The teacher's "Student videos" side window during a share (pure, tested in
 * tests/peerWindow.test.ts). The window always fits its tiles exactly: the
 * grid is sized for the tiles actually shown (you + students on camera, plus
 * "Connecting…" tiles briefly), and the window is resized to the grid.
 */

export const PEER_WIN_TILE_W = 192;
export const PEER_WIN_MIN_TILE_W = 120;
export const PEER_WIN_MAX_TILE_W = 480;
/** Header (2/4/6 buttons) and grid padding / gap, CSS px (match .peers-float-*). */
export const PEER_WIN_HEADER = 34;
export const PEER_WIN_PAD = 16;
export const PEER_WIN_GAP = 6;

/** Columns for `count` tiles: 1 → 1, 2 → 2×1, 3–4 → 2×2, 5–6 → 3×2. */
export function peerWindowCols(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  return 3;
}

export function peerWindowGrid(count: number, tileW: number = PEER_WIN_TILE_W) {
  const n = Math.max(1, Math.floor(count));
  const cols = peerWindowCols(n);
  const rows = Math.ceil(n / cols);
  const w = Math.round(Math.min(PEER_WIN_MAX_TILE_W, Math.max(PEER_WIN_MIN_TILE_W, tileW)));
  const tileH = Math.round((w * 9) / 16);
  return {
    cols,
    rows,
    tileW: w,
    tileH,
    gap: PEER_WIN_GAP,
    paneW: PEER_WIN_PAD + cols * w + PEER_WIN_GAP * (cols - 1),
    paneH: PEER_WIN_HEADER + PEER_WIN_PAD + rows * tileH + PEER_WIN_GAP * (rows - 1),
  };
}

/** Tile width that fills a window the teacher resized to `innerW` (height then snaps). */
export function peerWindowTileWForWidth(count: number, innerW: number): number {
  const cols = peerWindowCols(Math.max(1, count));
  const w = Math.floor((innerW - PEER_WIN_PAD - PEER_WIN_GAP * (cols - 1)) / cols);
  return Math.min(PEER_WIN_MAX_TILE_W, Math.max(PEER_WIN_MIN_TILE_W, w));
}

/**
 * Tiles to show in the window: you, every student on a tile, and blank
 * "Connecting…" tiles only while newly sampled students are still arriving.
 * Never more than the chosen 2/4/6.
 */
export function peerWindowTileCount(opts: { slots: number; filled: number; connecting: number }): number {
  const want = 1 + Math.max(0, opts.filled) + Math.max(0, opts.connecting);
  return Math.max(1, Math.min(opts.slots, want));
}

/** Outer size to open the window at (window chrome estimated; fixed after load). */
export function peerWindowOuterSize(count: number, tileW: number = PEER_WIN_TILE_W) {
  const g = peerWindowGrid(count, tileW);
  return { w: g.paneW + 16, h: g.paneH + 72 };
}

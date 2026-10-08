import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peerWindowGrid, peerWindowTileCount, peerWindowTileWForWidth, PEER_WIN_TILE_W } from '../src/lib/peerWindow';

test('grid shapes for 1..6 tiles', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => [peerWindowGrid(n).cols, peerWindowGrid(n).rows]), [
    [1, 1], [2, 1], [2, 2], [2, 2], [3, 2], [3, 2],
  ]);
});

test('pane size is exactly the tiles + header/padding (no empty band)', () => {
  const g = peerWindowGrid(4);
  assert.equal(g.paneW, 16 + 2 * PEER_WIN_TILE_W + 6);
  assert.equal(g.paneH, 34 + 16 + 2 * g.tileH + 6);
  assert.equal(g.tileH, Math.round((PEER_WIN_TILE_W * 9) / 16));
});

test('tile count follows the tiles actually shown, capped by 2/4/6', () => {
  assert.equal(peerWindowTileCount({ slots: 6, filled: 1, connecting: 0 }), 2);
  assert.equal(peerWindowTileCount({ slots: 6, filled: 2, connecting: 2 }), 5);
  assert.equal(peerWindowTileCount({ slots: 2, filled: 5, connecting: 0 }), 2);
  assert.equal(peerWindowTileCount({ slots: 4, filled: 0, connecting: 0 }), 1);
});

test('teacher widening the window scales tiles; grid width round-trips', () => {
  const w = peerWindowTileWForWidth(4, 600);
  const g = peerWindowGrid(4, w);
  assert.ok(Math.abs(g.paneW - 600) <= 2);
  assert.equal(peerWindowTileWForWidth(4, 50), 120);
  assert.equal(peerWindowTileWForWidth(1, 5000), 480);
});

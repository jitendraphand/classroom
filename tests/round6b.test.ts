import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readyPool, sampleCapForLayout, studentCapForLayout } from '../src/shared/classLogic';
import { levelLabel, smoothCpu } from '../src/shared/adaptiveCapture';

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('B2: End class is not ignored right after Stop sharing (no stale HUD check in main)', () => {
  const main = src('src/main/main.ts');
  const body = main.slice(main.indexOf("ipcMain.handle('confirm-end'"), main.indexOf("ipcMain.handle('confirm-end'") + 400);
  assert.doesNotMatch(body, /lastSnap\?\.hud\.sharing\) return false/);
});

test('B3: fullscreen-exit alert on the share toolbar, annotate tools and whiteboard meeting bar', () => {
  assert.match(src('src/renderer/toolbar.tsx'), /tsh-focus-alert/);
  assert.match(src('src/renderer/tools.tsx'), /hud\.focusAlerts/);
  assert.match(src('src/renderer/whiteboard.tsx'), /danger: hud\.focusAlerts > 0/);
});

test('B4: one warm spare camera and only frame-ready students rotate in', () => {
  assert.equal(studentCapForLayout(2), 1);
  assert.equal(sampleCapForLayout(2), 2);
  assert.equal(sampleCapForLayout(6), 6);
  const has = new Set(['b']);
  assert.deepEqual(readyPool(['a', 'b', 'c'], (id) => has.has(id), ['a']), ['a', 'b'], 'shown one stays, c (no frame yet) waits');
  assert.deepEqual(readyPool(['c'], () => false, []), ['c'], 'never empty when someone is live');
  assert.match(src('src/renderer/classSession.ts'), /maxVisibleVideos: sampleCapForLayout\(/);
});

test('B5: roster name keeps room next to chips', () => {
  const css = src('src/renderer/styles.css');
  assert.match(css, /\.roster-name \{ flex: 1 1 auto; min-width: 72px;/);
  assert.match(css, /\.roster-chip \{ flex: 0 1 auto; min-width: 0;/);
});

test('B6: the "joined from another device" notice clears itself', () => {
  const cs = src('src/renderer/classSession.ts');
  assert.match(cs, /TAKEOVER_NOTICE_MS = 8000/);
  assert.match(cs, /if \(this\.notice === text\)/);
});

test('B1: sidecar reports computer-sound level and the class window ducks the mic', () => {
  assert.match(src('native/share-sidecar/src/main.rs'), /event\("audio-level"/);
  assert.match(src('src/main/main.ts'), /'sidecar-audio-level'/);
  const cs = src('src/renderer/classSession.ts');
  assert.match(cs, /new MicDuckProcessor\(\)/);
  assert.match(cs, /HEADPHONES_HINT/);
});

test('adaptive capture: smoothed CPU, visible indicator, sampling logged', () => {
  let c = NaN;
  for (const s of [1, 0.75, 1, 0.8, 0.75]) c = smoothCpu(c, s);
  assert.ok(c >= 0.8, `81%-ish busy PC must count as busy (got ${c})`);
  assert.equal(levelLabel(0), '');
  assert.match(levelLabel(1), /Reduced/);
  assert.match(src('src/renderer/toolbar.tsx'), /tsh-adaptive/);
  assert.match(src('src/main/main.ts'), /\[capture\] cpu sample/);
});

test('whiteboard mode: videos window has 2/4/6, minimise, and is resizable', () => {
  const v = src('src/renderer/videos.tsx');
  assert.match(v, /videos-layout-\$\{n\}/);
  assert.match(src('src/main/main.ts'), /name === 'classroom-videos', \/\/ videos: drag-resize/);
});

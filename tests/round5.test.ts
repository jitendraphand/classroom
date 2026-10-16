import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOW_POWER, capEncodingFps, parseLowPower, shareFps, tileProfile } from '../src/shared/lowPower';
import { ALL_TOOLS, TOOL_GROUPS, parseOrient, tip, toolForKey, toolbarSize, BUTTON_PX } from '../src/shared/toolbarLayout';
import { HW_ENCODE_FEATURES, HW_ENCODE_BLOCKERS } from '../src/shared/hwEncode';
import { freshTakeovers, takeoverToastText } from '../src/shared/web/deviceTakeover';

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
const helper = readFileSync(new URL('../native/affinity-helper.c', import.meta.url), 'utf8');

test('low power: slides 5 fps, video 15 fps, smaller slower tiles', () => {
  assert.equal(shareFps({ videoMode: false, lowPower: false, slidesFps: 8, videoFps: 24 }), 8);
  assert.equal(shareFps({ videoMode: false, lowPower: true, slidesFps: 8, videoFps: 24 }), 5);
  assert.equal(shareFps({ videoMode: true, lowPower: false, slidesFps: 8, videoFps: 24 }), 24);
  assert.equal(shareFps({ videoMode: true, lowPower: true, slidesFps: 8, videoFps: 24 }), 15);
  assert.deepEqual(capEncodingFps([{ maxFramerate: 24, maxBitrate: 1 }, {}], 15), [{ maxFramerate: 15, maxBitrate: 1 }, { maxFramerate: 15 }]);
  assert.equal(tileProfile(true).fps, LOW_POWER.tileFps);
  assert.ok(tileProfile(true).size.width < tileProfile(false).size.width);
  assert.equal(parseLowPower('1'), true);
  assert.equal(parseLowPower(null), false);
  const cs = src('renderer/classSession.ts');
  assert.match(cs, /case 'toggle-low-power'/);
  assert.match(cs, /setWgcFps\(fps\)/);
  assert.match(src('renderer/toolbar.tsx'), /toggle-low-power/);
});

test('student tiles pause while their panel is hidden', () => {
  const cs = src('renderer/classSession.ts');
  assert.match(cs, /const on = stage\.has\(p\.identity\) && this\.panelShownNow\(\)/);
  assert.match(cs, /private panelShownNow\(\): boolean/);
});

test('helper lowers its priority on a static screen and restores it on change', () => {
  assert.match(helper, /BELOW_NORMAL_PRIORITY_CLASS/);
  assert.match(helper, /SetPriorityClass\(GetCurrentProcess\(\), NORMAL_PRIORITY_CLASS\)/);
  assert.match(helper, /#define STATIC_PRIO_MS 3000/);
});

test('hardware encode features ride the single enable-features switch', () => {
  const main = src('main/main.ts');
  assert.match(main, /'AllowWgcScreenCapturer', 'AllowWgcWindowCapturer', \.\.\.HW_ENCODE_FEATURES/);
  assert.ok(HW_ENCODE_FEATURES.includes('MediaFoundationVP9Encoding'));
  for (const b of HW_ENCODE_BLOCKERS) assert.ok(!main.includes(`appendSwitch('${b}'`), b);
});

test('annotate toolbar: grouped tools, shortcuts in tooltips, docks both ways', () => {
  assert.deepEqual(TOOL_GROUPS.map((g) => g.id), ['draw', 'shapes', 'point']);
  assert.equal(ALL_TOOLS.length, 9);
  assert.equal(new Set(ALL_TOOLS.map((t) => t.key)).size, 9);
  assert.equal(toolForKey('o')?.id, 'ellipse');
  assert.equal(tip('Pen', 'P'), 'Pen (P)');
  assert.ok(BUTTON_PX >= 36);
  const h = toolbarSize('horizontal');
  const v = toolbarSize('vertical');
  assert.ok(h.width > h.height && v.height > v.width);
  assert.equal(parseOrient('junk'), 'horizontal');
  const ui = src('renderer/tools.tsx');
  for (const s of ['<FlyoutBar', 'Clear student drawings', 'Clear all marks', 'Stop annotating', 'Dock vertically', 'on={tool === id}']) assert.ok(ui.includes(s), s);
  const main = src('main/main.ts');
  assert.match(main, /ipcMain\.on\('annotate-tools-orient'/);
  assert.match(main, /protectExcludedWindow\(win, 'annotate-tools'\)/);
});

test('teacher sees a toast when a student device takes over', () => {
  const now = Date.now();
  const list = [{ name: 'Asha', at: now + 1000 }] as never;
  assert.equal(freshTakeovers(list, now).length, 1);
  assert.ok(typeof takeoverToastText(freshTakeovers(list, now)[0]!) === 'string');
  assert.match(src('renderer/classSession.ts'), /takeoverToastText/);
});

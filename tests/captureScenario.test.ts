import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPTURE_TEST_DELAY_MS,
  FAIL_ANNOTATION,
  FAIL_BLACK,
  FAIL_CHROME,
  FAIL_LOCAL,
  FAIL_UNDERLYING,
  PANEL_CHROME,
  PASS_LINES,
  classifyProbeLaunch,
  inspectArrow,
  inspectPanelRegion,
  looksLikeNotepad,
  mapBoxToFrame,
  renderVerdict,
  runCaptureScenario,
  verdictFromFlags,
  waitForNextComposition,
  type ScenarioDeps,
  type ScenarioFrame,
} from '../src/shared/captureScenario';

function paint(frame: ScenarioFrame, x: number, y: number, rgba: [number, number, number, number]): void {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= frame.width || iy >= frame.height) return;
  const i = (iy * frame.width + ix) * 4;
  frame.rgba[i] = rgba[0];
  frame.rgba[i + 1] = rgba[1];
  frame.rgba[i + 2] = rgba[2];
  frame.rgba[i + 3] = rgba[3];
}

function fillRect(frame: ScenarioFrame, x: number, y: number, w: number, h: number, rgba: [number, number, number, number]): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) paint(frame, xx, yy, rgba);
  }
}

function notepadFrame(): ScenarioFrame {
  const width = 40;
  const height = 40;
  const rgba = new Uint8Array(width * height * 4);
  const frame = { width, height, rgba };
  fillRect(frame, 0, 0, width, height, [255, 255, 255, 255]);
  for (let y = 3; y < 36; y += 4) {
    for (let x = 3; x < 36; x += 3) paint(frame, x, y, [12, 12, 12, 255]);
  }
  return frame;
}

function copyFrame(frame: ScenarioFrame): ScenarioFrame {
  return { width: frame.width, height: frame.height, rgba: new Uint8Array(frame.rgba) };
}

const panelRect = { x: 4, y: 4, w: 14, h: 10 };
const pageRect = { x: 2, y: 2, w: 34, h: 34 };

function baseDeps(events: string[], frames: () => ScenarioFrame | null): ScenarioDeps {
  return {
    probe: 'ran',
    probeReason: '',
    wgcAvailable: true,
    sharing: false,
    savedDir: 'C:\\capture-test',
    sleep: async (ms) => {
      events.push(`sleep:${ms}`);
    },
    compose: async () => {
      events.push('compose');
    },
    protectControl: () => {
      events.push('protect');
      return true;
    },
    openNotepad: async () => {
      events.push('notepad');
      return true;
    },
    prepareDesktop: () => {
      events.push('desktop');
    },
    placeControl: (slot) => {
      events.push(`place:${slot}`);
    },
    controlReady: () => true,
    controlClear: () => true,
    panelRectInFrame: () => panelRect,
    notepadRectInFrame: () => pageRect,
    arrowSamplesInFrame: () => {
      const samples: Array<[number, number]> = [];
      for (let x = 6; x <= 30; x += 2) samples.push([x, 32]);
      return samples;
    },
    startCapture: async () => {
      events.push('start');
      return { ok: true, width: 40, height: 40 };
    },
    nextFrame: async () => {
      events.push('frame');
      return frames();
    },
    parkCursor: () => {
      events.push('cursor');
    },
    saveFrame: (name) => {
      events.push(`save:${name}`);
    },
    prepareOverlay: async () => {
      events.push('overlay');
    },
    overlayIsProtected: () => false,
    drawRedArrow: () => {
      events.push('arrow');
    },
    cleanup: () => {
      events.push('cleanup');
    },
    log: (line) => {
      events.push(line);
    },
    now: () => '2026-10-06T12:00:00.000Z',
  };
}

test('probe that does not execute is skipped and is not a pass', () => {
  assert.equal(CAPTURE_TEST_DELAY_MS >= 200 && CAPTURE_TEST_DELAY_MS <= 500, true);
  const skipped = classifyProbeLaunch('win32', true, { status: null, error: false, signal: false });
  assert.equal(skipped.kind, 'skipped');
  if (skipped.kind === 'skipped') {
    assert.equal(skipped.reason, 'Probe did not run.');
    assert.equal(skipped.reason.includes('not-run'), false);
  }
  assert.equal(classifyProbeLaunch('linux', true, null).kind, 'skipped');
  assert.equal(classifyProbeLaunch('win32', false, null).kind, 'skipped');
  const ran = classifyProbeLaunch('win32', true, { status: 0, error: false, signal: false });
  assert.deepEqual(ran, { kind: 'ran', status: 0 });
  const judged = verdictFromFlags({ skipped: 'Probe did not run.', local: true, absent: true, underlying: true, annotation: true, black: false });
  assert.equal(judged.verdict, 'skip');
  assert.equal(renderVerdict(judged.verdict, judged.lines).startsWith('PASS:'), false);
  assert.match(renderVerdict(judged.verdict, judged.lines), /^SKIP:\nProbe did not run\./);
});

test('composition wait resolves before the caller is allowed to start capture', async () => {
  const order: string[] = [];
  await waitForNextComposition(
    async () => {
      order.push('sleep');
    },
    async () => {
      order.push('compose');
    },
    300
  );
  order.push('start');
  assert.deepEqual(order, ['sleep', 'compose', 'start']);
});

test('notepad page, control-panel chrome, and a black rectangle are distinguished', () => {
  const page = notepadFrame();
  assert.equal(looksLikeNotepad(page, pageRect), true);
  const chrome = copyFrame(page);
  fillRect(chrome, panelRect.x, panelRect.y, panelRect.w, panelRect.h, [PANEL_CHROME.r, PANEL_CHROME.g, PANEL_CHROME.b, 255]);
  const chromeVerdict = inspectPanelRegion(page, chrome, panelRect);
  assert.equal(chromeVerdict.panelAbsent, false);
  assert.equal(chromeVerdict.underlying, false);
  const black = copyFrame(page);
  fillRect(black, panelRect.x, panelRect.y, panelRect.w, panelRect.h, [0, 0, 0, 255]);
  const blackVerdict = inspectPanelRegion(page, black, panelRect);
  assert.equal(blackVerdict.blackBox, true);
  assert.equal(blackVerdict.underlying, false);
  const same = inspectPanelRegion(page, copyFrame(page), panelRect);
  assert.equal(same.underlying, true);
  assert.equal(same.panelAbsent, true);
  assert.equal(same.blackBox, false);
  const flat = copyFrame(page);
  fillRect(flat, 0, 0, 40, 40, [PANEL_CHROME.r, PANEL_CHROME.g, PANEL_CHROME.b, 255]);
  assert.equal(looksLikeNotepad(flat, pageRect), false);
});

test('a red arrow is visible only when the captured frame gained red ink', () => {
  const ground = notepadFrame();
  const samples: Array<[number, number]> = [];
  for (let x = 6; x <= 30; x += 2) samples.push([x, 32]);
  const bare = inspectArrow(ground, copyFrame(ground), samples);
  assert.equal(bare.visible, false);
  const inked = copyFrame(ground);
  for (const [x, y] of samples) paint(inked, x, y, [255, 0, 0, 255]);
  const seen = inspectArrow(ground, inked, samples);
  assert.equal(seen.visible, true);
});

test('capture starts on a later turn and a matching Notepad frame passes', async () => {
  const events: string[] = [];
  const base = notepadFrame();
  let n = 0;
  const deps = baseDeps(events, () => {
    n += 1;
    if (n === 9) {
      const inked = copyFrame(base);
      for (let x = 6; x <= 30; x += 2) paint(inked, x, 32, [255, 0, 0, 255]);
      return inked;
    }
    return copyFrame(base);
  });
  const report = await runCaptureScenario(deps);
  const sleepAt = events.findIndex((e) => e.startsWith('sleep:'));
  const startAt = events.indexOf('start');
  const protectAt = events.indexOf('protect');
  assert.ok(protectAt >= 0 && sleepAt > protectAt && startAt > sleepAt);
  assert.equal(events.includes('sleep:300'), true);
  assert.equal(events.filter((e) => e === 'compose').length > 0, true);
  assert.deepEqual(
    events.filter((e) => e.startsWith('save:')),
    ['save:ground', 'save:over-a', 'save:over-b', 'save:arrow']
  );
  assert.equal(report.verdict, 'pass');
  assert.equal(report.controlProtected, true);
  assert.equal(report.text.startsWith('PASS:'), true);
  for (const line of PASS_LINES) assert.equal(report.lines.includes(line), true);
  assert.equal(report.captureStartedAt, '2026-10-06T12:00:00.000Z');
  assert.equal(report.frameWidth, 40);
  assert.equal(report.frameHeight, 40);
  assert.equal(events.at(-1), 'cleanup');
  const mapped = mapBoxToFrame({ x: 10, y: 20, w: 30, h: 40 }, { x: 0, y: 0, w: 100, h: 100 }, 50, 50);
  assert.deepEqual(mapped, { x: 5, y: 10, w: 15, h: 20 });
});

test('the control panel colour in the captured frame fails, and a protected overlay hides the arrow', async () => {
  const events: string[] = [];
  const base = notepadFrame();
  let n = 0;
  const chromeDeps = baseDeps(events, () => {
    n += 1;
    const frame = copyFrame(base);
    if (n === 5 || n === 7 || n === 9) {
      fillRect(frame, panelRect.x, panelRect.y, panelRect.w, panelRect.h, [PANEL_CHROME.r, PANEL_CHROME.g, PANEL_CHROME.b, 255]);
    }
    return frame;
  });
  const chrome = await runCaptureScenario(chromeDeps);
  assert.equal(chrome.verdict, 'fail');
  assert.equal(chrome.text.startsWith('PASS:'), false);
  assert.equal(chrome.lines.includes(FAIL_CHROME), true);
  assert.equal(chrome.lines.includes(FAIL_UNDERLYING), true);

  const blackEvents: string[] = [];
  let bn = 0;
  const blackDeps = baseDeps(blackEvents, () => {
    bn += 1;
    const frame = copyFrame(base);
    if (bn === 5 || bn === 7 || bn === 9) fillRect(frame, panelRect.x, panelRect.y, panelRect.w, panelRect.h, [0, 0, 0, 255]);
    return frame;
  });
  const black = await runCaptureScenario(blackDeps);
  assert.equal(black.verdict, 'fail');
  assert.equal(black.lines.includes(FAIL_BLACK), true);

  const hiddenEvents: string[] = [];
  let hn = 0;
  const hidden = baseDeps(hiddenEvents, () => {
    hn += 1;
    if (hn === 9) {
      const inked = copyFrame(base);
      for (let x = 6; x <= 30; x += 2) paint(inked, x, 32, [255, 0, 0, 255]);
      return inked;
    }
    return copyFrame(base);
  });
  hidden.overlayIsProtected = () => true;
  const hiddenReport = await runCaptureScenario(hidden);
  assert.equal(hiddenReport.verdict, 'fail');
  assert.equal(hiddenReport.lines.includes(FAIL_ANNOTATION), true);
  assert.equal(hiddenReport.lines.includes('Control panel visible locally'), false);
});

test('a skipped probe does not start capture and does not pass', async () => {
  const events: string[] = [];
  const deps = baseDeps(events, () => notepadFrame());
  deps.probe = 'skipped';
  deps.probeReason = 'Probe did not run.';
  const report = await runCaptureScenario(deps);
  assert.equal(report.verdict, 'skip');
  assert.equal(events.includes('start'), false);
  assert.equal(events.includes('notepad'), false);
  assert.match(report.text, /^SKIP:/);
  assert.equal(report.text.includes('PASS:'), false);
  assert.equal(events.at(-1), 'cleanup');
});

test('capture that shows the panel is not treated as a local-only success', async () => {
  const events: string[] = [];
  const deps = baseDeps(events, () => copyFrame(notepadFrame()));
  deps.controlReady = () => false;
  deps.protectControl = () => false;
  const report = await runCaptureScenario(deps);
  assert.equal(report.verdict, 'fail');
  assert.equal(report.controlProtected, false);
  assert.equal(report.lines.includes(FAIL_LOCAL), true);
  assert.equal(report.text.startsWith('PASS:'), false);
});

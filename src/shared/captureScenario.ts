/**
 * Pixel checks for the local Notepad capture test.
 *
 * The frames are Windows.Graphics.Capture output. Nothing here paints a
 * replacement image, masks a rectangle, or copies the desktop into the frame.
 */

export const CAPTURE_TEST_DELAY_MS = 300;

export const PANEL_CHROME = { r: 0x0f, g: 0x17, b: 0x2a };

export const PASS_LINES = [
  'Control panel visible locally',
  'Control panel absent from captured frame',
  'Underlying pixels visible',
  'Annotation visible',
] as const;

export const FAIL_CHROME = 'Control panel visible in capture';
export const FAIL_BLACK = 'Black/blank rectangle appears';
export const FAIL_UNDERLYING = 'Underlying pixels are missing';
export const FAIL_ANNOTATION = 'Annotation is missing';
export const FAIL_LOCAL = 'Control panel is not visible locally';

export type Box = { x: number; y: number; w: number; h: number };

export type RgbaFrame = {
  width: number;
  height: number;
  rgba: ArrayLike<number>;
};

export type ProbeLaunch = {
  status: number | null;
  error: boolean;
  signal: boolean;
};

export type ProbeClass =
  | { kind: 'skipped'; reason: string }
  | { kind: 'ran'; status: number };

/**
 * A probe that never executed is skipped. Callers must not treat that as a pass.
 * A missing exit status is a skip, not a result.
 */
export function classifyProbeLaunch(platform: string, helperExists: boolean, run: ProbeLaunch | null): ProbeClass {
  if (platform !== 'win32') {
    return { kind: 'skipped', reason: 'Not Windows, so the helper was not run.' };
  }
  if (!helperExists) {
    return { kind: 'skipped', reason: 'Helper missing, so the probe was not run.' };
  }
  if (!run || run.error || run.signal || run.status === null) {
    return { kind: 'skipped', reason: 'Probe did not run.' };
  }
  return { kind: 'ran', status: run.status };
}

/**
 * Yields, then waits for a desktop composition. Capture has to be started by
 * the caller after this promise resolves, so it is not in the same turn as
 * setContentProtection.
 */
export async function waitForNextComposition(
  sleep: (ms: number) => Promise<void>,
  compose: () => Promise<void>,
  delayMs: number = CAPTURE_TEST_DELAY_MS
): Promise<void> {
  await sleep(delayMs);
  await compose();
}

export function intersectBox(a: Box, b: Box): Box | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function insetBox(box: Box, px: number): Box | null {
  if (!(px >= 0) || box.w <= px * 2 || box.h <= px * 2) return null;
  return { x: box.x + px, y: box.y + px, w: box.w - px * 2, h: box.h - px * 2 };
}

/** Physical monitor pixels → the captured frame. Clips to the frame. */
export function mapBoxToFrame(box: Box, monitor: Box, frameW: number, frameH: number): Box | null {
  if (monitor.w < 2 || monitor.h < 2 || frameW < 2 || frameH < 2) return null;
  const sx = frameW / monitor.w;
  const sy = frameH / monitor.h;
  const mapped = {
    x: (box.x - monitor.x) * sx,
    y: (box.y - monitor.y) * sy,
    w: box.w * sx,
    h: box.h * sy,
  };
  const clipped = intersectBox(mapped, { x: 0, y: 0, w: frameW, h: frameH });
  if (!clipped || clipped.w < 8 || clipped.h < 8) return null;
  return clipped;
}

export function lineSamples(a: [number, number], b: [number, number], steps: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const n = Math.max(1, Math.floor(steps));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

type Rgb = { r: number; g: number; b: number };

function at(frame: RgbaFrame, x: number, y: number): Rgb | null {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= frame.width || iy >= frame.height) return null;
  const i = (iy * frame.width + ix) * 4;
  if (i + 2 >= frame.rgba.length) return null;
  return { r: frame.rgba[i] ?? 0, g: frame.rgba[i + 1] ?? 0, b: frame.rgba[i + 2] ?? 0 };
}

function closeTo(a: Rgb, b: Rgb, limit = 36): boolean {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) <= limit;
}

function nearBlack(p: Rgb): boolean {
  return p.r + p.g + p.b <= 18;
}

function isRedInk(p: Rgb): boolean {
  return p.r >= 180 && p.g <= 90 && p.b <= 90 && p.r - p.g >= 80 && p.r - p.b >= 80;
}

export type RegionVerdict = {
  compared: number;
  matchRatio: number;
  chromeRatio: number;
  blackRatio: number;
  groundBlackRatio: number;
  underlying: boolean;
  panelAbsent: boolean;
  blackBox: boolean;
};

/**
 * Compare one captured rectangle with the same rectangle in a frame taken
 * while the control panel was elsewhere. Match means the live pixels are the
 * desktop that was already there, not a repainted substitute.
 */
export function inspectPanelRegion(ground: RgbaFrame, live: RgbaFrame, rect: Box): RegionVerdict {
  const empty: RegionVerdict = {
    compared: 0,
    matchRatio: 0,
    chromeRatio: 1,
    blackRatio: 1,
    groundBlackRatio: 0,
    underlying: false,
    panelAbsent: false,
    blackBox: true,
  };
  if (ground.width !== live.width || ground.height !== live.height || ground.width < 2 || ground.height < 2) return empty;
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(live.width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(live.height, Math.ceil(rect.y + rect.h));
  let compared = 0;
  let matched = 0;
  let chrome = 0;
  let black = 0;
  let groundBlack = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const g = at(ground, x, y);
      const p = at(live, x, y);
      if (!g || !p) continue;
      compared += 1;
      if (closeTo(g, p)) matched += 1;
      if (closeTo(p, PANEL_CHROME, 30)) chrome += 1;
      if (nearBlack(p)) black += 1;
      if (nearBlack(g)) groundBlack += 1;
    }
  }
  if (compared < 64) return empty;
  const matchRatio = matched / compared;
  const chromeRatio = chrome / compared;
  const blackRatio = black / compared;
  const groundBlackRatio = groundBlack / compared;
  const blackBox = blackRatio > 0.45 && groundBlackRatio < 0.2;
  const panelAbsent = chromeRatio <= 0.08;
  const underlying = matchRatio >= 0.96 && panelAbsent && !blackBox;
  return { compared, matchRatio, chromeRatio, blackRatio, groundBlackRatio, underlying, panelAbsent, blackBox };
}

/**
 * Notepad's page is white with dark glyphs. A flat colour, the control-panel
 * chrome, or a black rectangle does not look like that page.
 */
export function looksLikeNotepad(frame: RgbaFrame, rect: Box): boolean {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(frame.width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(frame.height, Math.ceil(rect.y + rect.h));
  let compared = 0;
  let white = 0;
  let dark = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const p = at(frame, x, y);
      if (!p) continue;
      compared += 1;
      if (p.r >= 235 && p.g >= 235 && p.b >= 235) white += 1;
      if (p.r <= 50 && p.g <= 50 && p.b <= 50) dark += 1;
    }
  }
  if (compared < 64) return false;
  return white / compared > 0.35 && dark / compared > 0.004;
}

export type ArrowVerdict = { visible: boolean; hit: number; considered: number };

/** Red ink along the arrow, where the reference frame was not already red. */
export function inspectArrow(ground: RgbaFrame, live: RgbaFrame, samples: readonly [number, number][], radius = 3): ArrowVerdict {
  let hit = 0;
  let considered = 0;
  for (const [sx, sy] of samples) {
    if (ground.width !== live.width || ground.height !== live.height) continue;
    let sampleRed = false;
    let groundRed = false;
    let inside = false;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const g = at(ground, sx + dx, sy + dy);
        const p = at(live, sx + dx, sy + dy);
        if (!g || !p) continue;
        inside = true;
        if (isRedInk(g)) groundRed = true;
        if (isRedInk(p)) sampleRed = true;
      }
    }
    if (!inside || groundRed) continue;
    considered += 1;
    if (sampleRed) hit += 1;
  }
  const visible = considered >= 8 && hit / considered >= 0.35;
  return { visible, hit, considered };
}

export type ScenarioFlags = {
  /** Set when the test did not run. A skip is never a pass. */
  skipped?: string;
  local: boolean;
  absent: boolean;
  underlying: boolean;
  annotation: boolean;
  black: boolean;
};

export function verdictFromFlags(flags: ScenarioFlags): { verdict: 'pass' | 'fail' | 'skip'; lines: string[] } {
  if (flags.skipped) return { verdict: 'skip', lines: [flags.skipped] };
  const pass = flags.local && flags.absent && flags.underlying && flags.annotation && !flags.black;
  if (pass) return { verdict: 'pass', lines: [...PASS_LINES] };
  const lines: string[] = [];
  if (!flags.local) lines.push(FAIL_LOCAL);
  if (!flags.absent) lines.push(FAIL_CHROME);
  if (flags.black) lines.push(FAIL_BLACK);
  if (!flags.underlying) lines.push(FAIL_UNDERLYING);
  if (!flags.annotation) lines.push(FAIL_ANNOTATION);
  return { verdict: 'fail', lines };
}

export function renderVerdict(verdict: 'pass' | 'fail' | 'skip', lines: readonly string[]): string {
  const head = verdict === 'pass' ? 'PASS:' : verdict === 'fail' ? 'FAIL:' : 'SKIP:';
  return [head, ...lines].join('\n');
}

export type CaptureScenarioReport = {
  verdict: 'pass' | 'fail' | 'skip';
  text: string;
  lines: string[];
  controlProtected: boolean;
  captureStartedAt: string;
  firstFrameAt: string;
  frameWidth: number;
  frameHeight: number;
  savedDir: string;
  detail: string;
};

export type ScenarioFrame = { width: number; height: number; rgba: Uint8Array };

export type PanelSlot = 'aside' | 'over-a' | 'over-b' | 'over-arrow';

export type ScenarioDeps = {
  probe: 'ran' | 'skipped';
  probeReason: string;
  wgcAvailable: boolean;
  sharing: boolean;
  savedDir: string;
  sleep: (ms: number) => Promise<void>;
  compose: () => Promise<void>;
  protectControl: () => Promise<boolean> | boolean;
  openNotepad: () => Promise<boolean>;
  prepareDesktop: () => Promise<void> | void;
  placeControl: (slot: PanelSlot) => void;
  /** Control panel is on screen, content-protected, and overlaps Notepad. */
  controlReady: () => boolean;
  /** Control panel does not overlap Notepad, so the reference frame is the page. */
  controlClear: () => boolean;
  panelRectInFrame: (frame: ScenarioFrame) => Box | null;
  notepadRectInFrame: (frame: ScenarioFrame) => Box | null;
  arrowSamplesInFrame: (frame: ScenarioFrame) => Array<[number, number]>;
  startCapture: () => Promise<{ ok: true; width: number; height: number } | { ok: false; error: string }>;
  nextFrame: () => Promise<ScenarioFrame | null>;
  parkCursor: () => Promise<void> | void;
  saveFrame: (name: string, frame: ScenarioFrame) => void;
  prepareOverlay: () => Promise<void>;
  /** True only if something called setContentProtection on the overlay. That fails the test. */
  overlayIsProtected: () => boolean;
  drawRedArrow: () => void;
  cleanup: () => Promise<void> | void;
  log: (line: string) => void;
  now: () => string;
};

function reportFrom(
  verdict: 'pass' | 'fail' | 'skip',
  lines: string[],
  times: Pick<CaptureScenarioReport, 'controlProtected' | 'captureStartedAt' | 'firstFrameAt' | 'frameWidth' | 'frameHeight'>,
  savedDir: string,
  detail: string
): CaptureScenarioReport {
  return {
    verdict,
    lines,
    text: renderVerdict(verdict, lines),
    savedDir,
    detail,
    ...times,
  };
}

async function takeSettledFrame(deps: ScenarioDeps): Promise<ScenarioFrame | null> {
  await waitForNextComposition(deps.sleep, deps.compose, CAPTURE_TEST_DELAY_MS);
  await deps.parkCursor();
  await deps.nextFrame();
  const frame = await deps.nextFrame();
  return frame ? { width: frame.width, height: frame.height, rgba: new Uint8Array(frame.rgba) } : null;
}

function logDiagnostics(
  deps: ScenarioDeps,
  controlProtected: boolean,
  captureStartedAt: string,
  firstFrameAt: string,
  frameWidth: number,
  frameHeight: number
): void {
  const block = [
    '[capture-test]',
    `controlProtected=${controlProtected}`,
    `captureStartedAt=${captureStartedAt}`,
    `firstFrameAt=${firstFrameAt}`,
    `frameWidth=${frameWidth}`,
    `frameHeight=${frameHeight}`,
  ];
  for (const line of block) deps.log(line);
}

/**
 * Notepad under the control panel, then a red arrow on the unprotected overlay.
 * WebRTC is not started here. The caller starts capture only after
 * waitForNextComposition resolves.
 */
export async function runCaptureScenario(deps: ScenarioDeps): Promise<CaptureScenarioReport> {
  const times = {
    controlProtected: false,
    captureStartedAt: '',
    firstFrameAt: '',
    frameWidth: 0,
    frameHeight: 0,
  };
  const notes: string[] = [];
  try {
    if (deps.sharing) {
      return reportFrom('skip', ['A class share is running. Stop it, then run this test. This was not scored as a pass.'], times, deps.savedDir, '');
    }
    if (deps.probe !== 'ran') {
      const reason = deps.probeReason || 'Probe did not run.';
      return reportFrom('skip', [reason], times, deps.savedDir, reason);
    }
    if (!deps.wgcAvailable) {
      const reason = 'Windows.Graphics.Capture is not available. The capture test did not run and is not a pass.';
      return reportFrom('skip', [reason], times, deps.savedDir, reason);
    }

    const opened = await deps.openNotepad();
    if (!opened) {
      return reportFrom('fail', ['Notepad did not open, so no frame was inspected.'], times, deps.savedDir, 'notepad');
    }
    await deps.prepareDesktop();
    const protectedNow = (await deps.protectControl()) === true;
    times.controlProtected = protectedNow;

    deps.placeControl('aside');
    if (!deps.controlClear()) {
      notes.push('The control panel still overlapped Notepad, so there was no clean reference.');
    }
    await waitForNextComposition(deps.sleep, deps.compose, CAPTURE_TEST_DELAY_MS);
    times.captureStartedAt = deps.now();
    const started = await deps.startCapture();
    if (!started.ok) {
      logDiagnostics(deps, protectedNow, times.captureStartedAt, '', 0, 0);
      return reportFrom(
        'fail',
        ['Capture did not start, so no frame was inspected.'],
        times,
        deps.savedDir,
        started.error
      );
    }

    const first = await deps.nextFrame();
    times.firstFrameAt = first ? deps.now() : '';
    times.frameWidth = first?.width ?? started.width;
    times.frameHeight = first?.height ?? started.height;
    logDiagnostics(deps, protectedNow, times.captureStartedAt, times.firstFrameAt, times.frameWidth, times.frameHeight);
    if (!first) {
      return reportFrom('fail', [FAIL_UNDERLYING, 'No captured frame arrived.'], times, deps.savedDir, 'no-frame');
    }

    const ground = await takeSettledFrame(deps);
    if (!ground) {
      return reportFrom('fail', [FAIL_UNDERLYING], times, deps.savedDir, 'no-ground');
    }
    deps.saveFrame('ground', ground);
    const page = deps.notepadRectInFrame(ground);
    if (!page || !looksLikeNotepad(ground, page)) {
      notes.push('The reference frame did not show Notepad text.');
    }

    let localOk = protectedNow;
    let absentOk = true;
    let underlyingOk = Boolean(page && looksLikeNotepad(ground, page) && deps.controlClear());
    let black = false;
    let regions = 0;

    for (const slot of ['over-a', 'over-b'] as const) {
      deps.placeControl(slot);
      if (!deps.controlReady()) localOk = false;
      const live = await takeSettledFrame(deps);
      if (!live) {
        underlyingOk = false;
        notes.push(`${slot} produced no frame.`);
        continue;
      }
      deps.saveFrame(slot, live);
      const rect = deps.panelRectInFrame(live);
      if (!rect) {
        underlyingOk = false;
        notes.push(`${slot} did not cover Notepad.`);
        continue;
      }
      regions += 1;
      const region = inspectPanelRegion(ground, live, rect);
      notes.push(
        `${slot} match=${region.matchRatio.toFixed(4)} chrome=${region.chromeRatio.toFixed(4)} black=${region.blackRatio.toFixed(4)} compared=${region.compared}`
      );
      if (!region.underlying || !looksLikeNotepad(live, rect)) underlyingOk = false;
      if (!region.panelAbsent) absentOk = false;
      if (region.blackBox) black = true;
    }
    if (!regions) underlyingOk = false;

    await deps.prepareOverlay();
    const overlayProtected = deps.overlayIsProtected();
    if (overlayProtected) notes.push('The annotation overlay is content-protected, so its strokes cannot be required to appear.');
    deps.placeControl('over-arrow');
    if (!deps.controlReady()) localOk = false;
    deps.drawRedArrow();
    const arrowFrame = await takeSettledFrame(deps);
    let annotationOk = false;
    if (!arrowFrame) {
      notes.push('No frame arrived after the arrow was drawn.');
    } else {
      deps.saveFrame('arrow', arrowFrame);
      const rect = deps.panelRectInFrame(arrowFrame);
      if (rect) {
        const region = inspectPanelRegion(ground, arrowFrame, rect);
        notes.push(
          `over-arrow match=${region.matchRatio.toFixed(4)} chrome=${region.chromeRatio.toFixed(4)} black=${region.blackRatio.toFixed(4)}`
        );
        if (!region.underlying || !looksLikeNotepad(arrowFrame, rect)) underlyingOk = false;
        if (!region.panelAbsent) absentOk = false;
        if (region.blackBox) black = true;
      } else {
        underlyingOk = false;
      }
      if (!overlayProtected) {
        const arrow = inspectArrow(ground, arrowFrame, deps.arrowSamplesInFrame(arrowFrame));
        notes.push(`arrow hit=${arrow.hit} considered=${arrow.considered}`);
        annotationOk = arrow.visible;
      }
    }

    const judged = verdictFromFlags({
      local: localOk,
      absent: absentOk,
      underlying: underlyingOk,
      annotation: annotationOk,
      black,
    });
    const detail = notes.join(' ');
    deps.log(`[capture-test] ${judged.verdict}`);
    for (const line of notes) deps.log(`[capture-test] ${line}`);
    return reportFrom(judged.verdict, judged.lines, times, deps.savedDir, detail);
  } finally {
    await deps.cleanup();
  }
}

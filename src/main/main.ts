/**
 * Teacher desktop shell.
 *
 * Every opaque classroom window is capture-excluded. After it exists, this
 * process calls setContentProtection(true). Electron then calls
 * SetWindowDisplayAffinity on that HWND. A separate helper process cannot:
 * the API requires the HWND to belong to the caller. The helper is only the
 * Windows.Graphics.Capture capturer, plus DwmFlush and overlay click-through.
 * The annotation overlay stays unprotected so strokes remain in the capture.
 * The transparent region picker stays unprotected so it is not a black rectangle.
 * Protection takes effect on the next desktop composition, so capture waits
 * for that frame. Chromium desktop capture is not published: DXGI paints an
 * excluded window black.
 * The enable-features switch below is the only one. A second appendSwitch
 * would replace it.
 */

import { SIDECAR_PUBLISH_TIMEOUT_MS, controlLine, inkMessage, parseScreenToken, refreshInitLine, screenTokenPath, sidecarInit, type Publisher, type SidecarRequest } from '../shared/sidecar';
import { SIDECAR_HELPER_FPS, VIDEO_MODE_SHARE as SIDECAR_VIDEO } from '../shared/capture';
import { fitToolbar, flyoutBounds, movedBounds, parseOrient, stableNatural, toolbarSize } from '../shared/toolbarLayout';
import { HW_ENCODE_FEATURES } from '../shared/hwEncode';
import { busyFraction, cpuTimes, initialState as adaptiveInitial, levelLabel, levelProfile, nextState as adaptiveNext, smoothCpu, type AdaptiveState } from '../shared/adaptiveCapture';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  powerMonitor,
  protocol,
  screen,
  session,
  Tray,
  type BrowserWindow as Win,
} from 'electron';
import { ClassroomApi, errorMessage, type StoredConfig } from './api';
import { trayIcons, windowIcon } from './icon';
import { isTeacherAction, type PanelSnapshot, type TeacherAction } from '../shared/actions';
import { DEFAULT_HOTKEYS, DEFAULT_SERVER } from '../shared/apiModel';
import {
  LABEL_UNAVAILABLE,
  LABEL_WGC,
  SCREEN_SHARE,
  capturePlan,
  matchPhysicalDisplay,
  windowShouldBeCaptureExcluded,
  sideWindowBox,
  videoPanelSize,
  type CapturePlan,
  type SideKind,
  type WgcStartResult,
} from '../shared/capture';
import {
  classifyProbeLaunch,
  intersectBox,
  insetBox,
  lineSamples,
  mapBoxToFrame,
  runCaptureScenario,
  type Box,
  type CaptureScenarioReport,
  type ScenarioFrame,
} from '../shared/captureScenario';
import { closeNotepad, launchNotepad, parkCursorAt, placeNotepad, writeNotepadFixture, type NotepadRect } from './notepadWindow';
import { panelPixelDiff } from '../shared/pixelDiff';
import { isSlotCount, type SlotCount } from '../shared/classLogic';
import { ShapeLog, applyRemoteMessage, parseShape, type AnnotateCommand, type AnnotShape } from '../shared/annotateOverlay';
import { burnShapesIntoFrame } from '../shared/inkFrame';
import { createWgcPump } from './wgcPump';
import { createCaptureSupervisor, monitorArgs, pickDisplay, type CaptureTarget } from './captureSupervisor';
import { compositeInkLayer, layerAlreadyInFrame, parseInkLayer, type InkLayer } from '../shared/inkLayer';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

app.commandLine.appendSwitch('high-dpi-support', '1');
// Only enable-features call. The published track is the helper's WGC session;
// these flags stay on so a mask-path getDisplayMedia is not forced onto GDI.
// Hardware encoders (Electron fallback publish path): Media Foundation H.264
// is on by default; VP9 / AV1 MF encoders are opted in here (Chromium ignores
// unknown names and falls back to software when no hardware encoder exists).
app.commandLine.appendSwitch('enable-features', ['AllowWgcScreenCapturer', 'AllowWgcWindowCapturer', ...HW_ENCODE_FEATURES].join(','));
// Separate switch from enable-features. A second append of the same name would replace it.
// MediaStreamTrackGenerator lets the publisher hand RGBA frames to Chromium's encoder.
app.commandLine.appendSwitch('enable-blink-features', 'MediaStreamTrackGenerator');
// The publisher lives in the main window, which is minimized for the duration of the share.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.setName('Classroom Teacher');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

type Hotkeys = StoredConfig['hotkeys'];

let config: StoredConfig = defaultConfig();
let api: ClassroomApi;
let plan: CapturePlan = capturePlan(null);
let mainWindow: Win | null = null;
let toolbar: Win | null = null;
let tray: Tray | null = null;
let lastSnap: PanelSnapshot | null = null;
let pendingSource: { id: string; displayId: string; name: string; kind: string } | null = null;
let classActive = false;
let alerted = false;
const chrome = new Map<string, Win>();
let boundsTimer: NodeJS.Timeout | null = null;
type Frame = { width: number; height: number; rgba: Buffer };
let latestFrame: Frame | null = null;
let frameQueued = false;
let testWindow: Win | null = null;
let testRunning = false;
let probeExecuted = false;
let probeSkipReason = 'Probe did not run.';
let localCaptureProven = false;
let overlayDisplayId: number | null = null;
let overlayActive = false;
/** Annotation is on (tool panel open). Drawing vs click-through is overlayActive. */
let annotateOn = false;
let lastStudentInk: unknown = null;
let lastWgcArgs: string[] | null = null;
const overlayQueue: { channel: string; payload: unknown }[] = [];
let testMonitor: { x: number; y: number; w: number; h: number } | null = null;
let inkScale = 1;
const inkLog = new ShapeLog();
const frameListeners = new Set<(frame: Frame) => void>();

function clearInk(): void {
  inkLog.reset([]);
}

function rememberInk(channel: string, payload: unknown): void {
  if (channel !== 'annotate-command' || !payload || typeof payload !== 'object') return;
  const cmd = payload as AnnotateCommand;
  if (cmd.op === 'undo') inkLog.undo();
  else if (cmd.op === 'redo') inkLog.redo();
  else if (cmd.op === 'clear') inkLog.clear();
  else if (cmd.op === 'remote') applyRemoteMessage(inkLog, cmd.msg);
}

function replaceInk(raw: unknown): void {
  if (!Array.isArray(raw)) return;
  const shapes: AnnotShape[] = [];
  for (const item of raw) {
    const shape = parseShape(item);
    if (shape) shapes.push(shape);
  }
  inkLog.reset(shapes);
}

/**
 * Copy overlay strokes into a capture-test frame. A class share does not use
 * this: on a normal GPU desktop the unprotected overlay is already in the
 * Windows.Graphics.Capture texture, and burning the same strokes paints them
 * a second time on the student screen. The test still burns because a Remote
 * Desktop session without a GPU left that layered window out of the texture.
 */
function burnInk(frame: Frame): void {
  if (!inkLog.shapes.length) return;
  burnShapesIntoFrame(frame.rgba, frame.width, frame.height, inkLog.shapes, {
    scale: inkScale > 0 ? inkScale : 1,
    monitorW: testMonitor?.w || frame.width,
    monitorH: testMonitor?.h || frame.height,
  });
}

function captureLogPath(): string {
  try {
    return path.join(app.getPath('userData'), 'capture.log');
  } catch {
    return path.join(process.cwd(), 'capture.log');
  }
}

function logCapture(line: string): void {
  console.log(line);
  try {
    fs.appendFileSync(captureLogPath(), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* userData is not ready yet */
  }
}

/**
 * The helper sends a frame only when the picture changed (hash) and a 1 s
 * header-only heartbeat otherwise. The pristine last frame is kept here so a
 * changed ink layer over a static screen is re-composited without the helper,
 * and a heartbeat with no ink change costs the renderer nothing but a re-push
 * of the frame it already has (keyframes for late joiners).
 */
let lastRaw: Frame | null = null;
let inkDirty = false;

/**
 * Native screen-share sidecar: while `sidecarInitLine` is set the pump runs
 * share-sidecar.exe (which runs the helper and publishes to LiveKit itself).
 * Frames never reach Electron; stdout carries 1 s heartbeats only.
 */
let sidecarInitLine: string | null = null;
let sidecarPublished = false;
const sidecarWaiters = new Set<(ok: boolean, why: string) => void>();
const sidecarActive = () => sidecarInitLine !== null;
/** POST path for a fresh sidecar token (set while the sidecar publishes). */
let sidecarTokenPath: string | null = null;
/** Last Video-mode / share-sound choice, re-sent to a restarted sidecar. */
let sidecarVideoMode = false;
let sidecarAudioOn = false;

/** Fetch a fresh screen token into the init line before the sidecar (re)connects. */
async function refreshSidecarToken(): Promise<boolean> {
  if (!sidecarInitLine || !sidecarTokenPath) return false;
  const res = await api.call('POST', sidecarTokenPath).catch(() => null);
  const fresh = parseScreenToken(res);
  if (!fresh) {
    logCapture(`[sidecar] screen token refresh failed (status ${res ? res.status : 'none'})`);
    return false;
  }
  const next = refreshInitLine(sidecarInitLine, fresh, { audio: sidecarAudioOn });
  if (!next || !sidecarInitLine) return false;
  sidecarInitLine = next;
  logCapture('[sidecar] fresh screen token for reconnect');
  return true;
}

/**
 * Every supervisor restart (display change, no-frames, helper/sidecar exit)
 * goes through here: with the sidecar it reconnects with a fresh token and only
 * counts as recovered once the sidecar has published again.
 */
// Adaptive capture (item 4): busy / 2-core PCs share a smaller, slower picture.
let adaptive: AdaptiveState = adaptiveInitial(os.cpus().length);
let adaptiveSentLevel = -1;
let requestedShareFps = 8;
let lastCpu = cpuTimes(os.cpus());
let cpuSmooth = NaN;
/** Last adaptive status for the toolbars: level, label, smoothed CPU %. */
let adaptiveStatus = { level: 0, label: '', cpu: 0 };
function adaptiveTick(): void {
  const now = cpuTimes(os.cpus());
  const busy = busyFraction(lastCpu, now);
  lastCpu = now;
  cpuSmooth = smoothCpu(cpuSmooth, busy);
  if (!sidecarActive() || !lastSnap?.hud.sharing) {
    adaptiveSentLevel = -1;
    if (adaptiveStatus.level !== 0) publishAdaptive(0);
    return;
  }
  // Log the sampling itself every minute while sharing (verifies os.cpus() on this PC).
  if (Date.now() - lastCpuLog > 60_000) {
    lastCpuLog = Date.now();
    logCapture(`[capture] cpu sample ${Math.round(busy * 100)}% smoothed ${Math.round(cpuSmooth * 100)}% cores ${os.cpus().length} level ${adaptive.level}`);
  }
  adaptive = adaptiveNext(adaptive, cpuSmooth);
  const prof = levelProfile(adaptive.level, requestedShareFps, layerSize.h || 1080);
  if (adaptive.level !== adaptiveStatus.level) publishAdaptive(adaptive.level);
  // Resend while reduced: a sidecar restart forgets the cap.
  if (adaptive.level !== adaptiveSentLevel || adaptive.level > 0) {
    wgc.send(controlLine({ op: 'maxHeight', maxHeight: prof.maxHeight }));
    wgc.send(controlLine({ op: 'fps', fps: prof.fps }));
    if (adaptive.level !== adaptiveSentLevel) logCapture(`[capture] adaptive level ${adaptive.level} (cpu ${Math.round(busy * 100)}%): ${prof.maxHeight || 'native'}p @ ${prof.fps} fps`);
    adaptiveSentLevel = adaptive.level;
  }
}
let lastCpuLog = 0;
function publishAdaptive(level: number): void {
  adaptiveStatus = { level, label: levelLabel(level as 0 | 1 | 2), cpu: Math.round((Number.isFinite(cpuSmooth) ? cpuSmooth : 0) * 100) };
  for (const win of chrome.values()) if (!win.isDestroyed()) win.webContents.send('adaptive-status', adaptiveStatus);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('adaptive-status', adaptiveStatus);
}
setInterval(adaptiveTick, 3000).unref?.();

async function supervisedStart(args: string[]): Promise<Awaited<ReturnType<typeof wgc.start>>> {
  if (!sidecarActive()) return wgc.start(args);
  if (!(await refreshSidecarToken())) return { ok: false, error: 'screen-token' };
  sidecarPublished = false;
  const result = await wgc.start(args);
  if (!result.ok) return result;
  const pub = await waitSidecarPublished(SIDECAR_PUBLISH_TIMEOUT_MS);
  if (!pub.ok) {
    wgc.stop();
    return { ok: false, error: `sidecar ${pub.why || 'not published'}` };
  }
  if (sidecarVideoMode) wgc.send(controlLine({ op: 'mode', videoMode: true }));
  if (inkLayer) wgc.send(inkMessage(inkLayer));
  return result;
}

function onSidecarEvent(msg: { state: string; why: string }): void {
  if (msg.state === 'audio-level') {
    // 10x/s computer-sound level → class window (mic ducking, B1). Not logged.
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sidecar-audio-level', Number(msg.why));
    return;
  }
  logCapture(`[sidecar] ${msg.state}${msg.why ? ` ${msg.why}` : ''}`);
  if (msg.state === 'published') {
    sidecarPublished = true;
    for (const fn of sidecarWaiters) fn(true, msg.why);
  } else if (msg.state === 'error') {
    for (const fn of sidecarWaiters) fn(false, msg.why);
  } else if (msg.state === 'audio-error' || msg.state === 'audio-mode') {
    // Share audio is process loopback excluding this app; when that is unavailable no sound is sent.
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('sidecar-audio', { ok: msg.state === 'audio-mode', why: msg.why });
  }
}

function waitSidecarPublished(ms: number): Promise<{ ok: boolean; why: string }> {
  if (sidecarPublished) return Promise.resolve({ ok: true, why: '' });
  return new Promise((resolve) => {
    const done = (ok: boolean, why: string) => {
      clearTimeout(timer);
      sidecarWaiters.delete(done);
      resolve({ ok, why });
    };
    const timer = setTimeout(() => done(false, 'timeout'), ms);
    sidecarWaiters.add(done);
  });
}

function onHelperFrame(frame: Frame & { same?: boolean }): void {
  if (sidecarActive()) {
    // Sidecar heartbeat: the composited frame size, for the overlay layer and the supervisor.
    supervisor.frame();
    reportFrameSize(frame.width, frame.height);
    return;
  }
  if (!frame.same) {
    lastRaw = frame;
    deliverFrame(frame);
    return;
  }
  if (inkDirty && lastRaw && lastSnap?.hud.sharing && !testRunning) {
    deliverFrame(lastRaw);
    return;
  }
  supervisor.frame();
  for (const win of [mainWindow, testWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('wgc-frame', { width: frame.width, height: frame.height, same: true });
  }
}

/** Ink changed over a static screen: re-composite the last frame now (≤8/s) instead of waiting for the heartbeat. */
let inkTimer: ReturnType<typeof setTimeout> | null = null;
function kickInk(): void {
  inkDirty = true;
  if (inkTimer) return;
  inkTimer = setTimeout(() => {
    inkTimer = null;
    if (inkDirty && lastRaw && lastSnap?.hud.sharing && !testRunning) deliverFrame(lastRaw);
  }, 125);
}

function deliverFrame(raw: Frame): void {
  supervisor.frame();
  let frame = raw;
  inkDirty = false;
  if (testRunning) burnInk(frame);
  else if (inkLayer && lastSnap?.hud.sharing && !layerAlreadyInFrame(raw.rgba, raw.width, raw.height, inkLayer)) {
    // Composite into a copy: `raw` stays pristine for re-composites.
    frame = { width: raw.width, height: raw.height, rgba: Buffer.from(raw.rgba) };
    compositeInkLayer(frame.rgba, frame.width, frame.height, inkLayer);
  }
  reportFrameSize(frame.width, frame.height);
  latestFrame = frame;
  for (const fn of frameListeners) fn(frame);
  if (frameQueued) return;
  frameQueued = true;
  setImmediate(() => {
    frameQueued = false;
    const next = latestFrame;
    latestFrame = null;
    if (!next) return;
    for (const win of [mainWindow, testWindow]) {
      if (win && !win.isDestroyed()) win.webContents.send('wgc-frame', next);
    }
  });
}

function nextFrame(timeoutMs = 2500): Promise<Frame | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      frameListeners.delete(onFrame);
      resolve(null);
    }, timeoutMs);
    const onFrame = (frame: Frame) => {
      clearTimeout(timer);
      frameListeners.delete(onFrame);
      resolve(frame);
    };
    frameListeners.add(onFrame);
  });
}

function sendCaptureEnded(reason: string): void {
  for (const win of [mainWindow, testWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('wgc-ended', reason);
  }
}

const wgc = createWgcPump({
  helper: helperExe,
  wrap: (args) => (sidecarInitLine && fs.existsSync(sidecarExe()) ? { exe: sidecarExe(), args: [helperExe(), ...args], init: sidecarInitLine } : null),
  onSidecar: onSidecarEvent,
  onFrame: onHelperFrame,
  onEnded: (info) => {
    logCapture(`[capture] helper ended: ${info.reason}`);
    // A class share recovers by itself; anything else (capture test) ends.
    if (supervisor.armed() && lastSnap?.hud.sharing && !testRunning) supervisor.trigger(info.reason);
    else sendCaptureEnded(info.reason);
  },
  onLog: (line) => logCapture(line),
});

/** Physical rectangles of the current displays, for re-resolving a monitor share. */
function physicalDisplays(): { id: string; rect: { x: number; y: number; w: number; h: number } }[] {
  return screen.getAllDisplays().map((d) => {
    const phys = screen.dipToScreenRect(null, d.bounds);
    return { id: String(d.id), rect: { x: phys.x, y: phys.y, w: phys.width, h: phys.height } };
  });
}

let captureTarget: CaptureTarget | null = null;

const supervisor = createCaptureSupervisor({
  start: (args) => supervisedStart(args),
  argsFor: (target, fps) => {
    if (target.kind === 'window') {
      return ['capture-window', target.hwnd, String(SCREEN_SHARE.capture.width), String(SCREEN_SHARE.capture.height), String(fps)];
    }
    const d = pickDisplay(physicalDisplays(), target.displayId, target.rect);
    if (!d) return null;
    captureTarget = { kind: 'monitor', displayId: d.id, rect: d.rect };
    return monitorArgs(d.rect, SCREEN_SHARE.capture.width, SCREEN_SHARE.capture.height, fps);
  },
  onArgs: (args) => {
    lastWgcArgs = args;
  },
  onStatus: (status) => {
    logCapture(`[capture] supervisor ${status.state} (${status.reason}, attempt ${status.attempt})`);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('wgc-status', status);
    if (status.state === 'failed') sendCaptureEnded(`recovery failed: ${status.reason}`);
  },
  log: (line) => logCapture(line),
});
setInterval(() => supervisor.tick(), 1000).unref?.();

/** Overlay ink rendered by the annotation window, composited into every published frame. */
let inkLayer: InkLayer | null = null;
let layerSize = { w: 0, h: 0 };

function reportFrameSize(w: number, h: number): void {
  if (w === layerSize.w && h === layerSize.h) return;
  layerSize = { w, h };
  sendOverlay('annotate-layer-size', { w, h });
}

function defaultConfig(): StoredConfig {
  return {
    server: DEFAULT_SERVER,
    email: '',
    cookie: null,
    toolbar: null,
    layout: 4,
    hotkeys: { ...DEFAULT_HOTKEYS },
    micId: '',
    camId: '',
  };
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Partial<StoredConfig>;
    const server = typeof raw.server === 'string' && raw.server ? raw.server : DEFAULT_SERVER;
    const layout = typeof raw.layout === 'number' && isSlotCount(raw.layout) ? raw.layout : 4;
    const hotkeys = raw.hotkeys && typeof raw.hotkeys === 'object' ? raw.hotkeys : DEFAULT_HOTKEYS;
    config = {
      server,
      email: typeof raw.email === 'string' ? raw.email : '',
      cookie: typeof raw.cookie === 'string' && raw.cookie ? raw.cookie : null,
      toolbar:
        raw.toolbar && typeof raw.toolbar.x === 'number' && typeof raw.toolbar.y === 'number'
          ? { x: raw.toolbar.x, y: raw.toolbar.y }
          : null,
      layout,
      hotkeys: {
        mic: typeof hotkeys.mic === 'string' ? hotkeys.mic : DEFAULT_HOTKEYS.mic,
        camera: typeof hotkeys.camera === 'string' ? hotkeys.camera : DEFAULT_HOTKEYS.camera,
        stopShare: typeof hotkeys.stopShare === 'string' ? hotkeys.stopShare : DEFAULT_HOTKEYS.stopShare,
      },
      micId: typeof raw.micId === 'string' ? raw.micId : '',
      camId: typeof raw.camId === 'string' ? raw.camId : '',
    };
  } catch {
    config = defaultConfig();
  }
}

function saveConfig(): void {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(config), { mode: 0o600 });
  } catch (err) {
    console.log('[config] save failed');
  }
}

/** Helper capture args with a different frame rate (the last argument). */
function withCaptureFps(args: string[], fps: number): string[] {
  const out = [...args];
  out[out.length - 1] = String(Math.max(1, Math.min(30, Math.round(fps))));
  return out;
}

function sidecarExe(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'share-sidecar.exe');
  return path.join(__dirname, '..', 'native', 'share-sidecar.exe');
}

function helperExe(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'affinity-helper.exe');
  return path.join(__dirname, '..', 'native', 'affinity-helper.exe');
}

function readProbe(): CapturePlan {
  const features = app.commandLine.getSwitchValue('enable-features');
  const exe = helperExe();
  console.log(`[capture] chromium enable-features=${features}`);
  console.log(`[capture] helper ${exe}`);
  if (!features.includes('AllowWgcScreenCapturer') || !features.includes('AllowWgcWindowCapturer')) {
    console.log('[capture] AllowWgcScreenCapturer is missing from enable-features. A second appendSwitch would replace the value.');
  }
  const helperExists = fs.existsSync(exe);
  if (process.platform !== 'win32' || !helperExists) {
    const classified = classifyProbeLaunch(process.platform, helperExists, null);
    probeExecuted = false;
    probeSkipReason = classified.kind === 'skipped' ? classified.reason : 'Probe did not run.';
    const next = capturePlan(null, `${LABEL_UNAVAILABLE}. ${probeSkipReason}`);
    logCapture(`[capture] probe skipped: ${probeSkipReason}`);
    return next;
  }
  const run = spawnSync(exe, ['probe'], { windowsHide: true, timeout: 4000, encoding: 'utf8' });
  const stdout = (run.stdout || '').trim();
  const stderr = (run.stderr || '').trim();
  const classified = classifyProbeLaunch('win32', true, {
    status: run.status,
    error: Boolean(run.error),
    signal: run.signal != null,
  });
  if (classified.kind === 'skipped') {
    probeExecuted = false;
    probeSkipReason = classified.reason;
    logCapture(`[capture] probe skipped: ${classified.reason}`);
    return capturePlan(null, `${LABEL_UNAVAILABLE}. ${classified.reason}`);
  }
  probeExecuted = true;
  logCapture(`[capture] probe exit=${classified.status} stdout=${stdout}${stderr ? ` stderr=${stderr}` : ''}`);
  if (classified.status !== 0 || !stdout) {
    return capturePlan(null, `${LABEL_UNAVAILABLE}. Probe failed exit=${classified.status}.`);
  }
  try {
    const json = JSON.parse(stdout) as { build?: number; wgc?: boolean; wgcSession?: number; wgcItem?: boolean };
    const next = capturePlan({ build: Number(json.build) || 0, wgc: json.wgc === true });
    next.detail = `${next.label}. build=${json.build} wgc=${json.wgc} wgcSession=${json.wgcSession} wgcItem=${json.wgcItem} helper=${exe} features=${features}`;
    logCapture(`[capture] path=${next.label} mode=${next.mode} mask=${next.mask}`);
    return next;
  } catch {
    return capturePlan(null, `${LABEL_UNAVAILABLE}. Probe JSON was not readable.`);
  }
}

function hwndOf(win: Win): string | null {
  if (win.isDestroyed()) return null;
  try {
    const buf = win.getNativeWindowHandle();
    if (buf.length >= 8) return buf.readBigUInt64LE(0).toString(10);
    if (buf.length >= 4) return String(buf.readUInt32LE(0));
  } catch {
    return null;
  }
  return null;
}

/**
 * Content protection runs in this process, on each opaque classroom window.
 * Electron calls SetWindowDisplayAffinity on that window's own HWND.
 * Transparent windows are refused here even if a caller passes one.
 */
function protectExcludedWindow(win: Win, name: string): boolean {
  if (win.isDestroyed() || !windowShouldBeCaptureExcluded(name)) return false;
  win.setContentProtection(true);
  const protectedNow = win.isContentProtected();
  const hwnd = hwndOf(win) ?? '';
  console.log('[affinity]', name, 'id=', win.id, 'hwnd=', hwnd, 'protected=', protectedNow);
  logCapture(`[affinity] ${name} id=${win.id} hwnd=${hwnd} protected=${protectedNow}`);
  return protectedNow;
}

function logCaptureEnvironment(): void {
  const display = screen.getPrimaryDisplay();
  console.log('[capture] Electron version:', process.versions.electron);
  console.log('[capture] Chrome:', process.versions.chrome);
  console.log('[capture] platform:', process.platform);
  console.log('[capture] display', display.bounds, display.scaleFactor);
  logCapture(
    `[capture] electron=${process.versions.electron} chrome=${process.versions.chrome} platform=${process.platform} display=${display.bounds.x},${display.bounds.y} ${display.bounds.width}x${display.bounds.height} scale=${display.scaleFactor}`
  );
  for (const [name, win] of chrome) {
    if (win.isDestroyed() || !windowShouldBeCaptureExcluded(name)) continue;
    console.log('[affinity]', name, 'hwnd=', hwndOf(win) ?? '', 'protected=', win.isContentProtected());
  }
}

/**
 * setContentProtection applies on the next desktop composition, not when the
 * call returns. DwmFlush waits for that frame before Windows.Graphics.Capture starts.
 */
async function waitForDesktopComposition(): Promise<void> {
  const exe = helperExe();
  if (process.platform === 'win32' && fs.existsSync(exe)) {
    spawnSync(exe, ['settle'], { windowsHide: true, timeout: 3000 });
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/** Re-apply exclusion on every opaque classroom window. The toolbar flag is the Notepad check. */
async function ensureExcludedWindowsProtected(): Promise<boolean> {
  if (!toolbar || toolbar.isDestroyed()) showToolbar();
  const win = toolbar;
  if (!win || win.isDestroyed()) return false;
  if (!win.isVisible()) {
    await new Promise<void>((resolve) => {
      if (win.isDestroyed() || win.isVisible()) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 5000);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      win.once('show', done);
      setImmediate(() => {
        if (!win.isDestroyed() && win.isVisible()) done();
      });
    });
  }
  if (win.isDestroyed()) return false;
  let armed = 0;
  let missed = 0;
  for (const [name, target] of chrome) {
    if (!windowShouldBeCaptureExcluded(name) || target.isDestroyed()) continue;
    if (protectExcludedWindow(target, name)) armed += 1;
    else missed += 1;
  }
  logCapture(`[affinity] excluded windows protected=${armed} missed=${missed}`);
  if (missed > 0) logCapture(`[affinity] ${missed} classroom window(s) are not content-protected`);
  return win.isContentProtected();
}

function prefs() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    backgroundThrottling: false,
    webSecurity: true,
    enableBlinkFeatures: 'MediaStreamTrackGenerator,MediaStreamTrackProcessor',
  } as const;
}

function rendererRoot(): string {
  return path.join(__dirname, 'renderer');
}

function installProtocol(): void {
  protocol.handle('app', (req) => {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return new Response('bad url', { status: 400 });
    }
    if (url.hostname !== 'classroom') return new Response('not found', { status: 404 });
    let rel = decodeURIComponent(url.pathname);
    if (rel.startsWith('/')) rel = rel.slice(1);
    if (!rel || rel.includes('..') || rel.includes('\\')) return new Response('bad path', { status: 400 });
    const root = rendererRoot();
    const file = path.normalize(path.join(root, rel));
    const fromRoot = path.relative(root, file);
    if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) return new Response('bad path', { status: 400 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function publishBounds(): void {
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    boundsTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const windows: { name: string; x: number; y: number; w: number; h: number }[] = [];
    for (const [name, win] of chrome) {
      if (win.isDestroyed() || !win.isVisible()) continue;
      const b = win.getBounds();
      windows.push({ name, x: b.x, y: b.y, w: b.width, h: b.height });
    }
    const screens = screen.getAllDisplays().map((d) => ({
      left: d.bounds.x,
      top: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height,
      id: d.id,
      scaleFactor: d.scaleFactor,
    }));
    mainWindow.webContents.send('chrome-bounds', { windows, screens });
  }, 40);
}

/**
 * Cameras on demand: which student-video panels the teacher can see. The page
 * Visibility API is useless here (backgroundThrottling is off, so pages always
 * report 'visible'), so the main process tells the class window.
 */
function shownNow(win: Win | null | undefined): boolean {
  return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
}
let panelTimer: ReturnType<typeof setTimeout> | null = null;
function reportPanels(): void {
  if (panelTimer) return;
  panelTimer = setTimeout(() => {
    panelTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('panel-windows', { main: shownNow(mainWindow), videos: shownNow(chrome.get('classroom-videos')) });
  }, 50);
}

function watch(win: Win, name: string): void {
  chrome.set(name, win);
  if (name === 'classroom-videos') {
    for (const ev of ['show', 'hide', 'minimize', 'restore', 'closed'] as const) win.on(ev as 'show', reportPanels);
    win.webContents.once('did-finish-load', reportPanels);
  }
  const bump = () => publishBounds();
  win.on('move', bump);
  win.on('resize', bump);
  if (windowShouldBeCaptureExcluded(name)) protectExcludedWindow(win, name);
  win.on('show', () => {
    if (windowShouldBeCaptureExcluded(name)) protectExcludedWindow(win, name);
    if (name === 'annotate-overlay') setOverlayClickThrough(!overlayActive);
    publishBounds();
  });
  win.on('hide', () => {
    publishBounds();
  });
  win.on('closed', () => {
    if (chrome.get(name) === win) chrome.delete(name);
    publishBounds();
  });
}

function raiseToolbar(): void {
  raiseControls();
}

/** Control panel and the other classroom windows stay above the annotation overlay. */
function raiseControls(): void {
  for (const [name, win] of chrome) {
    if (name === 'annotate-overlay') continue;
    if (!win.isDestroyed() && win.isVisible()) win.moveTop();
  }
}

function sendOverlay(channel: string, payload: unknown): void {
  rememberInk(channel, payload);
  const win = chrome.get('annotate-overlay');
  if (!win || win.isDestroyed()) return;
  if (win.webContents.isLoading()) overlayQueue.push({ channel, payload });
  else win.webContents.send(channel, payload);
}

function flushOverlayQueue(win: Win): void {
  const queued = overlayQueue.splice(0, overlayQueue.length);
  for (const item of queued) win.webContents.send(item.channel, item.payload);
  win.webContents.send('annotate-mode', overlayActive);
  if (layerSize.w && layerSize.h) win.webContents.send('annotate-layer-size', layerSize);
  if (lastStudentInk) win.webContents.send('student-ink', lastStudentInk);
}

/** Overlay input on (draw) or off (click-through), told to the overlay and the tool panel. */
function setOverlayDrawing(on: boolean): void {
  overlayActive = on;
  setOverlayClickThrough(!overlayActive);
  sendOverlay('annotate-mode', overlayActive);
  const tools = chrome.get('annotate-tools');
  if (tools && !tools.isDestroyed()) tools.webContents.send('annotate-mode', overlayActive);
  const win = chrome.get('annotate-overlay');
  if (overlayActive && win && !win.isDestroyed()) win.focus();
  raiseControls();
}

/**
 * Annotation tool panel (pen, highlighter, shapes, text, eraser, undo/redo,
 * clear, colour, thickness, draw / click-through). Opaque and
 * capture-EXCLUDED like every other classroom panel: students see the marks
 * on the overlay, never the panel. Opens when annotation is turned on.
 */
function openAnnotateTools(): void {
  const existing = chrome.get('annotate-tools');
  if (existing && !existing.isDestroyed()) {
    existing.show();
    raiseControls();
    return;
  }
  const initial = toolbarSize(parseOrient(config.annotateToolsOrient));
  const w = initial.width;
  const h = Math.min(initial.height, workAreaFor(mainWindow).height);
  const tb = toolbar && !toolbar.isDestroyed() && toolbar.isVisible() ? toolbar.getBounds() : null;
  const area = workAreaFor(tb ? toolbar : mainWindow);
  let x = tb ? tb.x + tb.width - w : area.x + area.width - w - 16;
  let y = tb ? tb.y + tb.height + 8 : area.y + 96;
  if (y + h > area.y + area.height) y = Math.max(area.y, (tb ? tb.y : area.y + area.height) - h - 8);
  x = Math.min(Math.max(area.x, x), area.x + area.width - w);
  const savedPos = config.annotateTools;
  const saved =
    savedPos && screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return savedPos.x >= a.x && savedPos.y >= a.y && savedPos.x + w <= a.x + a.width && savedPos.y + h <= a.y + a.height;
    })
      ? savedPos
      : null;
  const win = new BrowserWindow({
    x: Math.round(saved?.x ?? x),
    y: Math.round(saved?.y ?? y),
    width: w,
    height: h,
    frame: false,
    transparent: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    thickFrame: false,
    show: false,
    backgroundColor: '#0f172a',
    webPreferences: prefs(),
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  watch(win, 'annotate-tools');
  win.on('moved', () => {
    if (win.isDestroyed()) return;
    // Never partly off-screen: clamp into the work area of the display it was dropped on.
    const open = toolsFlyout.size > 0;
    const b = open ? toolsBarRect(win) : win.getBounds();
    const c = movedBounds(b, toolsFixed, screen.getDisplayMatching(b).workArea);
    if (open) applyToolsFlyout(win, toolsFlyout.size, toolsFlyout.along);
    else if (c.x !== b.x || c.y !== b.y || c.width !== b.width || c.height !== b.height) win.setBounds(c);
    config.annotateTools = { x: c.x, y: c.y };
    saveConfig();
  });
  const refit = () => {
    if (!win.isDestroyed()) fitAnnotateTools(win);
  };
  screen.on('display-metrics-changed', refit);
  win.on('closed', () => {
    toolsFlyout = { size: 0, along: 0, side: 'after' };
    toolsExtraLines = 0;
    toolsFixed = null;
    screen.removeListener('display-metrics-changed', refit);
  });
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.send('annotate-mode', overlayActive);
    sendHud(win);
  });
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    // Protect BEFORE the first show, like the other panels.
    protectExcludedWindow(win, 'annotate-tools');
    win.show();
    raiseControls();
  });
  void win.loadURL('app://classroom/tools.html');
}

/** Annotate panel: measured one-line content size and the extra wrap lines it asked for. */
let toolsNatural: { width: number; height: number } | null = null;
let toolsExtraLines = 0;
/** The size fitAnnotateTools chose: drags keep exactly this size (no creep). */
let toolsFixed: { width: number; height: number } | null = null;

function fitAnnotateTools(win: BrowserWindow): void {
  const o = parseOrient(config.annotateToolsOrient);
  const natural = toolsNatural ?? toolbarSize(o);
  const b = toolsBarRect(win);
  const area = screen.getDisplayMatching(b).workArea;
  const fit = fitToolbar(o, natural, area, { x: b.x, y: b.y }, toolsExtraLines);
  if (toolsFlyout.size > 0) {
    toolsFixed = { width: fit.width, height: fit.height };
    toolsFlyout.size = 0; // re-opened by the panel's next report
  }
  toolsFixed = { width: fit.width, height: fit.height };
  if (fit.x !== b.x || fit.y !== b.y || fit.width !== b.width || fit.height !== b.height) {
    win.setBounds({ x: fit.x, y: fit.y, width: fit.width, height: fit.height });
  }
}

ipcMain.on('annotate-tools-orient', (event, orient: unknown) => {
  const win = chrome.get('annotate-tools');
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  const o = parseOrient(orient);
  if (config.annotateToolsOrient !== o) {
    config.annotateToolsOrient = o;
    saveConfig();
    toolsNatural = null;
    toolsExtraLines = 0;
    toolsFixed = null;
  }
  fitAnnotateTools(win);
});

/** Open flyout of the share toolbar: room across the bar (0 = closed), length along it, side used. */
let toolsFlyout = { size: 0, along: 0, side: 'after' as 'after' | 'before' };

/** Screen rect of the compact bar inside the tools window (excludes an open flyout). */
function toolsBarRect(win: BrowserWindow): { x: number; y: number; width: number; height: number } {
  const b = win.getBounds();
  const size = toolsFixed ?? { width: b.width, height: b.height };
  const o = parseOrient(config.annotateToolsOrient);
  const shift = toolsFlyout.size > 0 && toolsFlyout.side === 'before' ? toolsFlyout.size : 0;
  return { x: o === 'vertical' ? b.x + shift : b.x, y: o === 'horizontal' ? b.y + shift : b.y, width: size.width, height: size.height };
}

function applyToolsFlyout(win: BrowserWindow, size: number, along: number): void {
  const bar = toolsBarRect(win);
  const o = parseOrient(config.annotateToolsOrient);
  const { rect, side } = flyoutBounds(o, bar, size, along, screen.getDisplayMatching(bar).workArea);
  toolsFlyout = { size: size > 0 ? size : 0, along, side };
  const b = win.getBounds();
  if (rect.x !== b.x || rect.y !== b.y || rect.width !== b.width || rect.height !== b.height) win.setBounds(rect);
  win.webContents.send('annotate-tools-flyout-side', side);
}

ipcMain.on('annotate-tools-flyout', (event, m: unknown) => {
  const win = chrome.get('annotate-tools');
  if (!win || win.isDestroyed() || event.sender !== win.webContents || !m || typeof m !== 'object') return;
  const r = m as { size?: unknown; along?: unknown };
  const size = Math.max(0, Math.min(2000, Number(r.size) || 0));
  const along = Math.max(0, Math.min(4000, Number(r.along) || 0));
  if (Math.abs(size - toolsFlyout.size) <= 2 && Math.abs(along - toolsFlyout.along) <= 2) return;
  applyToolsFlyout(win, size, along);
});

ipcMain.on('annotate-tools-measure', (event, m: unknown) => {
  const win = chrome.get('annotate-tools');
  if (!win || win.isDestroyed() || event.sender !== win.webContents || !m || typeof m !== 'object') return;
  const r = m as { width?: unknown; height?: unknown; overflow?: unknown };
  if (r.overflow === true) {
    if (toolsExtraLines >= 3) return; // the panel scrolls from here on
    toolsExtraLines += 1;
  } else {
    const width = Number(r.width);
    const height = Number(r.height);
    if (!(width > 0 && width < 8000 && height > 0 && height < 8000)) return;
    const next = stableNatural(toolsNatural, { width, height });
    if (next === toolsNatural) return; // same size within rounding: nothing to refit
    toolsNatural = next;
    toolsExtraLines = 0;
  }
  fitAnnotateTools(win);
});

function closeAnnotateTools(): void {
  const win = chrome.get('annotate-tools');
  if (win && !win.isDestroyed()) win.close();
}

function displayForOverlay(displayId: unknown) {
  const found = screen.getAllDisplays().find((d) => String(d.id) === String(displayId ?? ''));
  return found ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

/** Map the helper's physical monitor rectangle onto an Electron display id. */
function displayIdForCapturedMonitor(
  monitor: { x: number; y: number; w: number; h: number } | null,
  fallback: string
): string {
  if (!monitor) return fallback;
  const displays = screen.getAllDisplays().map((display) => {
    const phys = screen.dipToScreenRect(null, display.bounds);
    return { id: display.id, x: phys.x, y: phys.y, w: phys.width, h: phys.height };
  });
  const hit = matchPhysicalDisplay(displays, monitor);
  if (hit) return hit;
  try {
    const dip = screen.screenToDipPoint({ x: monitor.x + monitor.w / 2, y: monitor.y + monitor.h / 2 });
    return String(screen.getDisplayNearestPoint(dip).id);
  } catch {
    return fallback;
  }
}

function placeAnnotationOverlay(): void {
  const win = chrome.get('annotate-overlay');
  if (!win || win.isDestroyed() || overlayDisplayId == null) return;
  const display = screen.getAllDisplays().find((d) => d.id === overlayDisplayId) ?? screen.getPrimaryDisplay();
  const b = display.bounds;
  win.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) });
  const placed = win.getBounds();
  const phys = screen.dipToScreenRect(win, placed);
  inkScale = display.scaleFactor > 0 ? display.scaleFactor : 1;
  sendOverlay('annotate-surface', {
    dip: { x: placed.x, y: placed.y, w: placed.width, h: placed.height },
    physical: { x: phys.x, y: phys.y, widthPx: phys.width, heightPx: phys.height },
    scale: display.scaleFactor,
  });
}

function setOverlayClickThrough(on: boolean): void {
  const win = chrome.get('annotate-overlay');
  if (!win || win.isDestroyed()) return;
  if (on) {
    // Mouse and keyboard both fall through to the application underneath.
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setFocusable(false);
    win.blur();
  } else {
    win.setFocusable(true);
    win.setIgnoreMouseEvents(false);
  }
  const hwnd = hwndOf(win);
  const exe = helperExe();
  if (process.platform === 'win32' && hwnd && fs.existsSync(exe)) {
    const run = spawnSync(exe, ['clickthrough', hwnd, on ? '1' : '0'], { windowsHide: true, timeout: 3000, encoding: 'utf8' });
    const helperResult = run.status === null ? 'skipped' : String(run.status);
    logCapture(`[affinity] annotate-overlay click-through=${on ? 'on' : 'off'} helperExit=${helperResult} ${(run.stdout || run.stderr || '').trim()}`);
  }
}

function openAnnotationOverlay(displayId: unknown): void {
  const display = displayForOverlay(displayId);
  overlayDisplayId = display.id;
  const existing = chrome.get('annotate-overlay');
  if (existing && !existing.isDestroyed()) {
    placeAnnotationOverlay();
    setOverlayClickThrough(!overlayActive);
    raiseControls();
    return;
  }
  const b = display.bounds;
  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: true,
    hasShadow: false,
    thickFrame: false,
    show: false,
    webPreferences: prefs(),
  });
  // Left unprotected on purpose. setContentProtection here would hide the strokes.
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  watch(win, 'annotate-overlay');
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    placeAnnotationOverlay();
    flushOverlayQueue(win);
  });
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    placeAnnotationOverlay();
    setOverlayClickThrough(!overlayActive);
    win.showInactive();
    raiseControls();
  });
  void win.loadURL('app://classroom/annotate.html');
}

function closeAnnotationOverlay(): void {
  overlayActive = false;
  annotateOn = false;
  lastStudentInk = null;
  inkLayer = null;
  inkDirty = true;
  closeAnnotateTools();
  overlayDisplayId = null;
  clearInk();
  overlayQueue.splice(0, overlayQueue.length);
  const win = chrome.get('annotate-overlay');
  if (win && !win.isDestroyed()) win.close();
}

function workAreaFor(win: Win | null) {
  const point = win && !win.isDestroyed() ? win.getBounds() : null;
  const display = point
    ? screen.getDisplayMatching(point)
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return display.workArea;
}

function videosSize(): { w: number; h: number } {
  const area = workAreaFor(chrome.get('classroom-videos') ?? toolbar ?? mainWindow);
  return videoPanelSize({ width: area.width, height: area.height }, config.layout);
}

function place(kind: SideKind): { x: number; y: number; w: number; h: number } {
  const tb = toolbar && !toolbar.isDestroyed() && toolbar.isVisible() ? toolbar.getBounds() : null;
  const area = workAreaFor(kind === 'videos' ? chrome.get('classroom-videos') ?? toolbar ?? mainWindow : tb ? toolbar : mainWindow);
  const video = kind === 'videos' ? videosSize() : null;
  const box = sideWindowBox(
    kind,
    tb ? { x: tb.x, y: tb.y, w: tb.width, h: tb.height } : null,
    { left: area.x, top: area.y, width: area.width, height: area.height },
    video ? { videos: video } : {}
  );
  return { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.w), h: Math.round(box.h) };
}

/** Size only. Called when the videos window is created, or when layout or the display changes. */
function resizeVideos(): void {
  const win = chrome.get('classroom-videos');
  if (!win || win.isDestroyed()) return;
  const size = videosSize();
  const b = win.getBounds();
  const area = workAreaFor(win);
  let x = b.x;
  let y = b.y;
  if (x + size.w > area.x + area.width) x = area.x + area.width - size.w;
  if (y + size.h > area.y + area.height) y = area.y + area.height - size.h;
  if (x < area.x) x = area.x;
  if (y < area.y) y = area.y;
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: size.w, height: size.h });
  publishBounds();
}

function defaultToolbarPos(w: number, h: number): { x: number; y: number } {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  return { x: Math.round(area.x + area.width - w - 16), y: Math.round(area.y + 16) };
}

function sendHud(win: Win): void {
  if (lastSnap && !win.isDestroyed()) win.webContents.send('hud-state', lastSnap);
}

function forward(action: TeacherAction): void {
  if (!isTeacherAction(action)) return;
  if (action.type === 'show-main') {
    restoreMain();
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('action', action);
}

function showToolbar(): void {
  if (toolbar && !toolbar.isDestroyed()) {
    toolbar.show();
    raiseToolbar();
    return;
  }
  const pos = config.toolbar ?? defaultToolbarPos(720, 64);
  toolbar = new BrowserWindow({
    x: Math.round(pos.x),
    y: Math.round(pos.y),
    width: 720,
    height: 64,
    frame: false,
    transparent: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    thickFrame: false,
    show: false,
    backgroundColor: '#0f172a',
    webPreferences: prefs(),
  });
  toolbar.setAlwaysOnTop(true, 'screen-saver');
  toolbar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  watch(toolbar, 'toolbar');
  let snapping = false;
  toolbar.on('moved', () => {
    if (!toolbar || toolbar.isDestroyed() || snapping) return;
    const b = toolbar.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const snap = 18;
    let x = b.x;
    let y = b.y;
    if (Math.abs(x - area.x) <= snap) x = area.x;
    if (Math.abs(x + b.width - (area.x + area.width)) <= snap) x = area.x + area.width - b.width;
    if (Math.abs(y - area.y) <= snap) y = area.y;
    if (Math.abs(y + b.height - (area.y + area.height)) <= snap) y = area.y + area.height - b.height;
    if (x !== b.x || y !== b.y) {
      snapping = true;
      toolbar.setBounds({ x, y, width: b.width, height: b.height });
      snapping = false;
    }
    config.toolbar = { x, y };
    saveConfig();
  });
  toolbar.webContents.on('did-finish-load', () => {
    if (toolbar) sendHud(toolbar);
  });
  toolbar.once('ready-to-show', () => {
    if (!toolbar) return;
    protectExcludedWindow(toolbar, 'toolbar');
    toolbar.show();
    raiseToolbar();
  });
  toolbar.on('closed', () => {
    toolbar = null;
  });
  void toolbar.loadURL('app://classroom/toolbar.html');
}

function hideShareChrome(): void {
  const bar = chrome.get('toolbar');
  if (bar && !bar.isDestroyed()) bar.hide();
  closeAnnotationOverlay();
  for (const name of ['chat', 'roster', 'devices', 'classroom-videos', 'annotate-preview', 'region-picker']) {
    const win = chrome.get(name);
    if (win && !win.isDestroyed()) win.close();
  }
  publishBounds();
}

function openPanel(kind: 'chat' | 'roster' | 'devices'): void {
  let win = chrome.get(kind);
  if (win && !win.isDestroyed()) {
    if (!win.isVisible()) {
      win.show();
      sendHud(win);
    }
    raiseToolbar();
    return;
  }
  const box = place(kind);
  win = new BrowserWindow({
    x: box.x,
    y: box.y,
    width: box.w,
    height: box.h,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#0f172a',
    webPreferences: prefs(),
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  watch(win, kind);
  win.webContents.on('did-finish-load', () => sendHud(win!));
  win.once('ready-to-show', () => {
    protectExcludedWindow(win!, kind);
    win!.show();
    raiseToolbar();
  });
  void win.loadURL(`app://classroom/panel.html?kind=${kind}`);
}

function togglePanel(kind: string): void {
  if (kind !== 'chat' && kind !== 'roster' && kind !== 'devices') return;
  const existing = chrome.get(kind);
  if (existing && !existing.isDestroyed() && existing.isVisible()) {
    existing.hide();
    publishBounds();
    return;
  }
  openPanel(kind);
  if (kind === 'chat') forward({ type: 'mark-chat-read' });
}

function restoreMain(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function parseFeatures(features: string): { x: number; y: number; w: number; h: number } {
  const map: Record<string, number> = {};
  for (const part of features.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    map[part.slice(0, eq).trim()] = Number(part.slice(eq + 1));
  }
  const num = (k: string, fallback: number) => (Number.isFinite(map[k]) ? map[k]! : fallback);
  return { x: num('left', 48), y: num('top', 48), w: num('width', 640), h: num('height', 420) };
}

let pendingChild: { name: string; bounds: { x: number; y: number; w: number; h: number } } | null = null;

function attachChildWindows(win: Win): void {
  win.webContents.setWindowOpenHandler((details) => {
    const name = details.frameName || '';
    if (!['classroom-videos', 'annotate-overlay', 'annotate-preview', 'region-picker', 'classroom-whiteboard'].includes(name)) {
      return { action: 'deny' };
    }
    const requested = parseFeatures(details.features);
    const bounds = name === 'classroom-videos' ? place('videos') : requested;
    pendingChild = { name, bounds };
    const transparent = name === 'annotate-overlay' || name === 'region-picker';
    if (name === 'classroom-whiteboard') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          width: Math.max(800, Math.round(bounds.w)),
          height: Math.max(500, Math.round(bounds.h)),
          title: 'Whiteboard',
          backgroundColor: '#0f172a',
          show: false,
          autoHideMenuBar: true,
          webPreferences: prefs(),
        },
      };
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.w),
        height: Math.round(bounds.h),
        frame: false,
        transparent,
        hasShadow: !transparent,
        backgroundColor: transparent ? '#00000000' : '#0f172a',
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: name === 'annotate-preview' || name === 'classroom-videos', // videos: drag-resize like the web panel
        movable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        show: false,
        webPreferences: prefs(),
      },
    };
  });
  win.webContents.on('did-create-window', (child, details) => {
    const name = details.frameName || `child-${child.id}`;
    const wanted = pendingChild && pendingChild.name === name ? pendingChild.bounds : null;
    if (wanted) child.setBounds({ x: wanted.x, y: wanted.y, width: wanted.w, height: wanted.h });
    if (name !== 'classroom-whiteboard') {
      child.setAlwaysOnTop(true, 'pop-up-menu');
      child.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    watch(child, name);
    child.once('ready-to-show', () => {
      if (wanted && !child.isDestroyed()) child.setBounds({ x: wanted.x, y: wanted.y, width: wanted.w, height: wanted.h });
      // Whiteboard: tools on the left, meeting bar on the right, full work area.
      if (name === 'classroom-whiteboard' && !child.isDestroyed()) child.maximize();
      protectExcludedWindow(child, name);
      child.show();
      raiseToolbar();
    });
  });
}

function registerHotkeys(): void {
  globalShortcut.unregisterAll();
  if (!classActive) return;
  const map: [string, TeacherAction][] = [
    [config.hotkeys.mic, { type: 'toggle-mic' }],
    [config.hotkeys.camera, { type: 'toggle-cam' }],
    [config.hotkeys.stopShare, { type: 'stop-share' }],
  ];
  for (const [accel, action] of map) {
    if (!accel) continue;
    try {
      const ok = globalShortcut.register(accel, () => forward(action));
      if (!ok) console.log(`[hotkey] not registered ${accel}`);
    } catch {
      console.log(`[hotkey] not registered ${accel}`);
    }
  }
}

function trayTooltip(): string {
  const hud = lastSnap?.hud;
  if (!hud?.inClass) return 'Classroom Teacher';
  return `Classroom Teacher — ${hud.classLabel || 'In class'} — ${hud.waitingCount} waiting, ${hud.hands} hands, ${hud.unread} new`;
}

function refreshTray(): void {
  if (!tray) return;
  const hud = lastSnap?.hud;
  const attention = !!hud && (hud.waitingCount > 0 || hud.hands > 0 || hud.unread > 0 || hud.focusAlerts > 0);
  const icons = trayIcons(iconDir());
  tray.setImage(attention ? icons.alert : icons.normal);
  tray.setToolTip(trayTooltip().slice(0, 120));
  alerted = attention;
}

function iconDir(): string {
  const built = path.join(__dirname, '..', 'build');
  if (fs.existsSync(built)) return built;
  return path.join(process.resourcesPath, 'build');
}

function rebuildTrayMenu(): void {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show class', click: () => restoreMain() },
      { label: 'Mute or unmute', click: () => forward({ type: 'toggle-mic' }), enabled: classActive },
      { label: 'Stop sharing', click: () => forward({ type: 'stop-share' }), enabled: classActive },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
}

function createTray(): void {
  const icons = trayIcons(iconDir());
  tray = new Tray(icons.normal);
  tray.setToolTip('Classroom Teacher');
  rebuildTrayMenu();
  tray.on('click', () => restoreMain());
  tray.on('double-click', () => restoreMain());
}

function bootPayload() {
  return {
    server: config.server,
    email: config.email,
    hasCookie: !!config.cookie,
    layout: config.layout,
    hotkeys: config.hotkeys,
    micId: config.micId,
    camId: config.camId,
    capture: plan,
    platform: process.platform,
  };
}

type AffinityRow = { name: string; hwnd: string; protected: boolean; ok: boolean; captured: boolean };

function queryWindow(name: string, win: Win): AffinityRow {
  const hwnd = hwndOf(win) ?? '';
  const excluded = windowShouldBeCaptureExcluded(name);
  const protectedNow = !win.isDestroyed() && win.isContentProtected();
  return {
    name,
    hwnd,
    protected: protectedNow,
    ok: excluded ? protectedNow : !protectedNow,
    captured: !excluded,
  };
}

function diagnostics(): { label: string; detail: string; logPath: string; windows: AffinityRow[] } {
  const windows: AffinityRow[] = [];
  for (const [name, win] of chrome) {
    if (!win.isDestroyed()) windows.push(queryWindow(name, win));
  }
  return { label: plan.label, detail: plan.detail, logPath: captureLogPath(), windows };
}

function ensureTestVideos(): void {
  const existing = chrome.get('classroom-videos');
  if (existing && !existing.isDestroyed()) {
    existing.show();
    resizeVideos();
    return;
  }
  const box = place('videos');
  const win = new BrowserWindow({
    x: box.x,
    y: box.y,
    width: box.w,
    height: box.h,
    frame: false,
    transparent: false,
    backgroundColor: '#0f172a',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: prefs(),
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  watch(win, 'classroom-videos');
  win.once('ready-to-show', () => {
    resizeVideos();
    protectExcludedWindow(win, 'classroom-videos');
    win.show();
    raiseToolbar();
  });
  void win.loadURL('app://classroom/videos.html');
}

function openCaptureTestWindow(): void {
  showToolbar();
  if (testWindow && !testWindow.isDestroyed()) {
    testWindow.show();
    return;
  }
  testWindow = new BrowserWindow({
    width: 880,
    height: 780,
    show: false,
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    title: 'Capture test',
    webPreferences: prefs(),
  });
  watch(testWindow, 'capture-test');
  testWindow.once('ready-to-show', () => {
    if (!testWindow) return;
    protectExcludedWindow(testWindow, 'capture-test');
    testWindow.show();
  });
  testWindow.on('closed', () => {
    testWindow = null;
    if (testRunning) {
      testRunning = false;
      if (!lastSnap?.hud.sharing) wgc.stop();
    }
  });
  void testWindow.loadURL('app://classroom/capture-test.html');
}

async function startCaptureTest(): Promise<{ ok: boolean; error?: string; label: string; detail: string; logPath: string; windows: AffinityRow[] }> {
  const base = diagnostics();
  if (process.platform !== 'win32') {
    return { ok: false, error: 'This preview runs on Windows 10 version 2004 or later. It was not started on this machine.', ...base };
  }
  if (lastSnap?.hud.sharing) {
    return { ok: false, error: 'Stop the class share first. The test never publishes to students.', ...base };
  }
  if (plan.mode !== 'wgc-exclude') return { ok: false, error: plan.detail, ...base };
  const protectedOk = await ensureExcludedWindowsProtected();
  logCaptureEnvironment();
  if (!protectedOk) logCapture('[affinity] control panel is not content-protected');
  await waitForDesktopComposition();
  const display = screen.getPrimaryDisplay();
  const phys = screen.dipToScreenRect(null, display.bounds);
  testMonitor = { x: phys.x, y: phys.y, w: phys.width, h: phys.height };
  testRunning = true;
  const result = await wgc.start([
    'capture-monitor',
    String(phys.x),
    String(phys.y),
    String(phys.x + phys.width),
    String(phys.y + phys.height),
    '1920',
    '1080',
    '15',
  ]);
  if (!result.ok) {
    testRunning = false;
    logCapture(`[capture-test] failed ${result.error}`);
    return { ok: false, error: result.error, ...diagnostics() };
  }
  testRunning = true;
  logCapture(`[capture-test] preview ${result.width}x${result.height} log=${captureLogPath()}`);
  return { ok: true, ...diagnostics() };
}

function stopCaptureTest(): void {
  const was = testRunning;
  testRunning = false;
  if (was && !lastSnap?.hud.sharing) wgc.stop();
  if (!classActive) {
    if (toolbar && !toolbar.isDestroyed()) toolbar.hide();
    for (const name of ['chat', 'roster', 'classroom-videos']) {
      const win = chrome.get(name);
      if (win && !win.isDestroyed()) win.hide();
    }
  }
  if (testWindow && !testWindow.isDestroyed()) testWindow.close();
}

function frameRectOf(win: Win, frameW: number, frameH: number): { x: number; y: number; w: number; h: number } | null {
  if (!testMonitor || win.isDestroyed() || !win.isVisible()) return null;
  const phys = screen.dipToScreenRect(win, win.getBounds());
  const sx = frameW / testMonitor.w;
  const sy = frameH / testMonitor.h;
  const rect = {
    x: Math.round((phys.x - testMonitor.x) * sx),
    y: Math.round((phys.y - testMonitor.y) * sy),
    w: Math.round(phys.width * sx),
    h: Math.round(phys.height * sy),
  };
  if (rect.w < 2 || rect.h < 2) return null;
  return rect;
}

async function runCaptureDiff(): Promise<{ pass: boolean; ratio: number; compared: number; changed: number; note: string }> {
  const empty = { pass: false, ratio: 1, compared: 0, changed: 0 };
  if (!testRunning || !testMonitor) {
    return { ...empty, note: 'Start the capture exclusion test first. The comparison does not publish anything to students.' };
  }
  const panel = chrome.get('toolbar');
  const wins = panel && !panel.isDestroyed() && panel.isVisible() ? [panel] : [];
  if (!wins.length) return { ...empty, note: 'Show the control panel, then compare again.' };
  for (const win of wins) win.hide();
  await waitForDesktopComposition();
  const reference = await nextFrame();
  for (const win of wins) {
    win.show();
    protectExcludedWindow(win, 'toolbar');
  }
  raiseToolbar();
  await waitForDesktopComposition();
  const live = await nextFrame();
  if (!reference || !live || reference.width !== live.width || reference.height !== live.height) {
    const note = 'Could not read two frames of the same size.';
    logCapture(`[capture-test] ${note}`);
    return { ...empty, note };
  }
  const rects = wins
    .map((win) => frameRectOf(win, reference.width, reference.height))
    .filter((rect): rect is { x: number; y: number; w: number; h: number } => !!rect);
  const diff = panelPixelDiff(reference.rgba, live.rgba, reference.width, reference.height, rects);
  const note = diff.pass
    ? 'The pixels under the control panel match the desktop captured while that panel was hidden.'
    : 'The control panel region changed. The observer may be seeing the panel, or a rectangle, instead of Notepad underneath.';
  logCapture(`[capture-test] diff pass=${diff.pass} ratio=${diff.ratio.toFixed(4)} compared=${diff.compared} changed=${diff.changed}`);
  return { ...diff, note };
}

function writeFramePng(file: string, frame: ScenarioFrame): void {
  const bgra = Buffer.alloc(frame.width * frame.height * 4);
  const src = frame.rgba;
  for (let i = 0; i < bgra.length; i += 4) {
    bgra[i] = src[i + 2] ?? 0;
    bgra[i + 1] = src[i + 1] ?? 0;
    bgra[i + 2] = src[i] ?? 0;
    bgra[i + 3] = src[i + 3] ?? 255;
  }
  fs.writeFileSync(file, nativeImage.createFromBitmap(bgra, { width: frame.width, height: frame.height, scaleFactor: 1 }).toPNG());
}

function notepadPage(notepad: NotepadRect): Box | null {
  const useClient = notepad.cw > 40 && notepad.ch > 40;
  const outer = useClient
    ? { x: notepad.cx, y: notepad.cy, w: notepad.cw, h: notepad.ch }
    : { x: notepad.x + 16, y: notepad.y + 80, w: notepad.w - 32, h: notepad.h - 112 };
  return insetBox(outer, 8);
}

/**
 * Local Notepad capture test. Does not change content protection and does not
 * start WebRTC. Capture begins only after waitForNextComposition resolves.
 */
async function runNotepadCaptureScenario(): Promise<CaptureScenarioReport> {
  clearInk();
  const savedDir = path.join(app.getPath('userData'), 'capture-test', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(savedDir, { recursive: true });
  const display = screen.getPrimaryDisplay();
  const displayPhys = screen.dipToScreenRect(null, display.bounds);
  const monitorBox: Box = { x: displayPhys.x, y: displayPhys.y, w: displayPhys.width, h: displayPhys.height };
  const area = display.workArea;
  const noteDip = {
    x: area.x + 12,
    y: area.y + 12,
    width: Math.max(420, Math.round(area.width * 0.42)),
    height: Math.max(380, Math.round(area.height * 0.62)),
  };
  const notePhys = screen.dipToScreenRect(null, noteDip);

  let notepad: NotepadRect | null = null;
  let launchedPid = 0;
  let arrow: { a: { x: number; y: number }; b: { x: number; y: number } } | null = null;
  const hidden: string[] = [];
  let mainWasMinimized = true;
  let toolbarBack: { x: number; y: number; width: number; height: number } | null = null;
  let testBack: { x: number; y: number; width: number; height: number } | null = null;
  let captureOn = false;
  let touched = false;

  const panelBox = (): Box | null => {
    if (!toolbar || toolbar.isDestroyed()) return null;
    const p = screen.dipToScreenRect(toolbar, toolbar.getBounds());
    return { x: p.x, y: p.y, w: p.width, h: p.height };
  };
  const page = (): Box | null => (notepad ? notepadPage(notepad) : null);
  const placePanel = (physX: number, physY: number): void => {
    if (!toolbar || toolbar.isDestroyed()) return;
    const b = toolbar.getBounds();
    const dip = screen.screenToDipPoint({ x: physX, y: physY });
    toolbar.setBounds({ x: Math.round(dip.x), y: Math.round(dip.y), width: b.width, height: b.height });
  };

  const report = await runCaptureScenario({
    probe: probeExecuted ? 'ran' : 'skipped',
    probeReason: probeSkipReason,
    wgcAvailable: plan.mode === 'wgc-exclude' && !plan.mask,
    sharing: lastSnap?.hud.sharing === true,
    savedDir,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    compose: () => waitForDesktopComposition(),
    protectControl: async () => {
      const ok = await ensureExcludedWindowsProtected();
      if (toolbar && !toolbar.isDestroyed() && !toolbarBack) toolbarBack = toolbar.getBounds();
      return ok;
    },
    openNotepad: async () => {
      touched = true;
      const fixture = writeNotepadFixture(savedDir);
      launchedPid = launchNotepad(fixture) ?? 0;
      notepad = placeNotepad(savedDir, notePhys.x, notePhys.y, notePhys.width, notePhys.height);
      const body = page();
      if (!notepad || notepad.w < 80 || notepad.h < 80) return false;
      if (body) {
        arrow = {
          a: { x: body.x + 20, y: body.y + Math.round(body.h * 0.62) },
          b: { x: body.x + body.w - 20, y: body.y + Math.round(body.h * 0.84) },
        };
      }
      return true;
    },
    prepareDesktop: () => {
      if (testWindow && !testWindow.isDestroyed()) {
        testBack = testWindow.getBounds();
        const tw = Math.min(640, Math.max(360, Math.round(area.width * 0.36)));
        const th = Math.min(560, Math.max(320, Math.round(area.height * 0.5)));
        testWindow.setBounds({
          x: Math.round(area.x + area.width - tw - 12),
          y: Math.round(area.y + area.height - th - 12),
          width: tw,
          height: th,
        });
      }
      mainWasMinimized = mainWindow?.isMinimized() ?? false;
      if (mainWindow && !mainWindow.isDestroyed() && !mainWasMinimized) mainWindow.minimize();
      for (const name of ['chat', 'roster', 'devices', 'classroom-videos']) {
        const win = chrome.get(name);
        if (win && !win.isDestroyed() && win.isVisible()) {
          hidden.push(name);
          win.hide();
        }
      }
    },
    placeControl: (slot) => {
      const body = page();
      const panel = panelBox();
      if (!body || !panel) return;
      if (slot === 'aside') {
        let x = body.x + body.w + 24;
        let y = body.y + 16;
        if (x + panel.w > monitorBox.x + monitorBox.w - 8) {
          x = monitorBox.x + 16;
          y = body.y + body.h + 24;
        }
        if (y + panel.h > monitorBox.y + monitorBox.h - 8) y = monitorBox.y + 16;
        placePanel(x, y);
        return;
      }
      if (slot === 'over-b') {
        placePanel(body.x + 12, body.y + Math.round(body.h * 0.28));
        return;
      }
      placePanel(body.x + 12, body.y + 8);
    },
    controlReady: () => {
      if (!toolbar || toolbar.isDestroyed() || !toolbar.isVisible() || !toolbar.isContentProtected()) return false;
      const hit = panelBox() && page() ? intersectBox(panelBox()!, page()!) : null;
      return Boolean(hit && hit.w >= 20 && hit.h >= 20);
    },
    controlClear: () => {
      const panel = panelBox();
      const body = page();
      if (!panel || !body) return false;
      return intersectBox(panel, body) === null;
    },
    panelRectInFrame: (frame) => {
      const panel = panelBox();
      const body = page();
      if (!panel || !body) return null;
      const hit = intersectBox(panel, body);
      if (!hit) return null;
      return mapBoxToFrame(insetBox(hit, 4) ?? hit, monitorBox, frame.width, frame.height);
    },
    notepadRectInFrame: (frame) => {
      const body = page();
      if (!body) return null;
      return mapBoxToFrame(body, monitorBox, frame.width, frame.height);
    },
    arrowSamplesInFrame: (frame) => {
      if (!arrow || monitorBox.w < 2 || monitorBox.h < 2) return [];
      const sx = frame.width / monitorBox.w;
      const sy = frame.height / monitorBox.h;
      const a: [number, number] = [(arrow.a.x - monitorBox.x) * sx, (arrow.a.y - monitorBox.y) * sy];
      const b: [number, number] = [(arrow.b.x - monitorBox.x) * sx, (arrow.b.y - monitorBox.y) * sy];
      return lineSamples(a, b, 24);
    },
    startCapture: async () => {
      const result = await wgc.start([
        'capture-monitor',
        String(displayPhys.x),
        String(displayPhys.y),
        String(displayPhys.x + displayPhys.width),
        String(displayPhys.y + displayPhys.height),
        '1920',
        '1080',
        '15',
      ]);
      if (!result.ok) return { ok: false, error: result.error };
      captureOn = true;
      testRunning = true;
      testMonitor = { x: displayPhys.x, y: displayPhys.y, w: displayPhys.width, h: displayPhys.height };
      return { ok: true, width: result.width, height: result.height };
    },
    nextFrame: () => nextFrame(4000),
    parkCursor: () => {
      parkCursorAt(savedDir, displayPhys.x + displayPhys.width - 4, displayPhys.y + displayPhys.height - 4);
    },
    saveFrame: (name, frame) => {
      try {
        writeFramePng(path.join(savedDir, `${name}.png`), frame);
      } catch (err) {
        logCapture(`[capture-test] could not save ${name}`);
      }
    },
    prepareOverlay: async () => {
      overlayActive = true;
      openAnnotationOverlay(String(display.id));
      const win = chrome.get('annotate-overlay');
      if (win && !win.isDestroyed() && win.webContents.isLoading()) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5000);
          win.webContents.once('did-finish-load', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    overlayIsProtected: () => {
      const win = chrome.get('annotate-overlay');
      return Boolean(win && !win.isDestroyed() && win.isContentProtected());
    },
    drawRedArrow: () => {
      if (!arrow) return;
      const norm = (p: { x: number; y: number }): [number, number] => [
        (p.x - monitorBox.x) / monitorBox.w,
        (p.y - monitorBox.y) / monitorBox.h,
      ];
      sendOverlay('annotate-command', {
        op: 'remote',
        msg: {
          v: 1,
          type: 'shape',
          shape: {
            id: 'capture-test-arrow',
            type: 'arrow',
            points: [norm(arrow.a), norm(arrow.b)],
            color: '#ff0000',
            width: 14,
            opacity: 1,
            text: '',
            timestamp: Date.now(),
          },
        },
      });
      sendOverlay('annotate-mode', true);
    },
    cleanup: () => {
      if (!touched && !captureOn) return;
      try {
        if (captureOn || testRunning) {
          captureOn = false;
          testRunning = false;
          if (!lastSnap?.hud.sharing) wgc.stop();
        }
        closeAnnotationOverlay();
        closeNotepad(savedDir, notepad?.pid || launchedPid);
        for (const name of hidden) {
          const win = chrome.get(name);
          if (win && !win.isDestroyed()) win.show();
        }
        if (toolbar && toolbarBack && !toolbar.isDestroyed()) toolbar.setBounds(toolbarBack);
        if (testWindow && testBack && !testWindow.isDestroyed()) testWindow.setBounds(testBack);
        if (mainWindow && !mainWindow.isDestroyed() && !mainWasMinimized && mainWindow.isMinimized()) mainWindow.restore();
      } catch {
        logCapture('[capture-test] cleanup failed');
      }
    },
    log: logCapture,
    now: () => new Date().toISOString(),
  });

  try {
    fs.writeFileSync(path.join(savedDir, 'result.json'), JSON.stringify(report, null, 2));
  } catch {
    logCapture('[capture-test] could not write result.json');
  }
  logCapture(`[capture-test] ${report.text.replace(/\n/g, ' | ')}`);
  return report;
}

function installIpc(): void {
  ipcMain.handle('boot', async () => {
    let me: { role: string; name: string; email: string; mustChangePassword: boolean } | null = null;
    let reason: string | null = null;
    if (config.cookie) {
      const res = await api.call('GET', '/api/auth/me');
      const data = res.data as Record<string, unknown> | null;
      if (res.status === 200 && data?.role === 'teacher') {
        me = {
          role: 'teacher',
          name: typeof data.name === 'string' ? data.name : '',
          email: typeof data.email === 'string' ? data.email : config.email,
          mustChangePassword: data.mustChangePassword === true,
        };
      } else if (data && typeof data.reason === 'string') {
        reason = data.reason;
      }
    }
    return { ...bootPayload(), me, reason };
  });

  ipcMain.handle('login', async (_e, email: unknown, password: unknown) => {
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
      return { ok: false, error: 'Enter your email and password.' };
    }
    const res = await api.call('POST', '/api/auth/login', { email: email.trim(), password });
    const data = (res.data ?? {}) as Record<string, unknown>;
    if (res.status === 200 && data.role === 'admin') {
      await api.call('POST', '/api/auth/logout');
      api.setCookie(null);
      return { ok: false, error: 'This app is for teachers. Admin accounts sign in on the website.' };
    }
    if (res.status !== 200 || data.role !== 'teacher') {
      return { ok: false, error: errorMessage(res.data, 'Could not sign in.') };
    }
    config.email = email.trim();
    saveConfig();
    return {
      ok: true,
      mustChangePassword: data.mustChangePassword === true,
      name: typeof data.name === 'string' ? data.name : '',
      email: typeof data.email === 'string' ? data.email : email.trim(),
    };
  });

  ipcMain.handle('logout', async () => {
    await api.call('POST', '/api/auth/logout');
    api.setCookie(null);
    return { ok: true };
  });

  ipcMain.handle('change-password', async (_e, currentPassword: unknown, newPassword: unknown) => {
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return { ok: false, error: 'Enter your current and new password.' };
    }
    const res = await api.call('POST', '/api/auth/change-password', { currentPassword, newPassword });
    if (res.status !== 200) return { ok: false, error: errorMessage(res.data, 'Could not change the password.') };
    return { ok: true };
  });

  ipcMain.handle('api', async (_e, method: unknown, apiPath: unknown, body: unknown) => {
    if (typeof method !== 'string' || typeof apiPath !== 'string') return { status: 400, data: { error: 'Bad request' } };
    return api.call(method, apiPath, body === undefined ? undefined : body);
  });

  ipcMain.handle('set-server', async (_e, url: unknown) => {
    if (typeof url !== 'string') return { ok: false, error: 'Enter a server address.' };
    const next = api.setServer(url);
    if (!next) return { ok: false, error: 'Use an http or https address without a username or password in it.' };
    return { ok: true, server: next };
  });

  ipcMain.handle('list-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 160, height: 100 },
      fetchWindowIcons: false,
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      displayId: s.display_id,
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
    }));
  });

  ipcMain.handle('prepare-capture', (_e, source: unknown) => {
    if (!source || typeof source !== 'object') return false;
    const s = source as { id?: unknown; displayId?: unknown; name?: unknown; kind?: unknown };
    if (typeof s.id !== 'string' || !s.id) return false;
    pendingSource = {
      id: s.id,
      displayId: typeof s.displayId === 'string' ? s.displayId : '',
      name: typeof s.name === 'string' ? s.name : '',
      kind: s.kind === 'screen' ? 'screen' : 'window',
    };
    return true;
  });

  ipcMain.handle('capture-plan', () => plan);

  ipcMain.handle('start-wgc', async (event, req: unknown): Promise<WgcStartResult> => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return { ok: false, error: 'denied' };
    if (process.platform !== 'win32') return { ok: false, error: 'not-windows' };
    if (plan.mode !== 'wgc-exclude' || plan.mask) return { ok: false, error: 'capture-unavailable' };
    if (!req || typeof req !== 'object') return { ok: false, error: 'bad request' };
    const body = req as { kind?: unknown; sourceId?: unknown; displayId?: unknown };
    if (typeof body.sourceId !== 'string' || !body.sourceId) return { ok: false, error: 'bad request' };
    if (testRunning) {
      testRunning = false;
      wgc.stop();
    }
    const protectedOk = await ensureExcludedWindowsProtected();
    logCaptureEnvironment();
    if (!protectedOk) logCapture('[affinity] control panel is not content-protected');
    await waitForDesktopComposition();
    let args: string[];
    if (body.kind === 'window') {
      const hwnd = /^window:(\d+)/.exec(body.sourceId);
      if (!hwnd) return { ok: false, error: 'window-hwnd' };
      // The helper resolves this HWND's monitor and calls CreateForMonitor.
      // CreateForWindow would omit the annotation overlay.
      args = [
        'capture-window',
        hwnd[1]!,
        String(SCREEN_SHARE.capture.width),
        String(SCREEN_SHARE.capture.height),
        String(SCREEN_SHARE.capture.frameRate),
      ];
    } else {
      const display = screen.getAllDisplays().find((d) => String(d.id) === String(body.displayId ?? ''));
      if (!display) return { ok: false, error: 'display-not-found' };
      const phys = screen.dipToScreenRect(null, display.bounds);
      args = [
        'capture-monitor',
        String(phys.x),
        String(phys.y),
        String(phys.x + phys.width),
        String(phys.y + phys.height),
        String(SCREEN_SHARE.capture.width),
        String(SCREEN_SHARE.capture.height),
        String(SCREEN_SHARE.capture.frameRate),
      ];
    }
    // Option A: the native sidecar publishes the share itself. Any failure
    // before "published" falls back to the Electron publish path.
    let publisher: Publisher = 'electron';
    const sideReq = (body as { sidecar?: SidecarRequest }).sidecar;
    const init =
      sideReq && typeof sideReq === 'object' && fs.existsSync(sidecarExe())
        ? sidecarInit(sideReq, {
            slidesFps: SCREEN_SHARE.capture.frameRate,
            videoFps: SIDECAR_VIDEO.encoding.maxFramerate,
            maxBitrate: SCREEN_SHARE.encoding.maxBitrate,
            videoBitrate: SIDECAR_VIDEO.encoding.maxBitrate,
            excludePid: process.pid, // share audio leaves out this app's own sound (no echo)
          })
        : null;
    let result: Awaited<ReturnType<typeof wgc.start>>;
    // Sidecar: the helper's capture rate cannot change later, so start it at
    // the Video mode rate; the sidecar paces slides down to their own rate.
    const electronArgs = args;
    if (init) args = withCaptureFps(args, SIDECAR_HELPER_FPS);
    if (init) {
      sidecarInitLine = JSON.stringify(init);
      sidecarTokenPath = screenTokenPath(sideReq?.code);
      sidecarVideoMode = false;
      sidecarAudioOn = init.audio;
      sidecarPublished = false;
      result = await wgc.start(args);
      const pub = result.ok ? await waitSidecarPublished(SIDECAR_PUBLISH_TIMEOUT_MS) : { ok: false, why: result.error };
      if (result.ok && pub.ok) {
        publisher = 'sidecar';
      } else {
        sidecarInitLine = null;
        sidecarTokenPath = null;
        wgc.stop();
        if (result.ok) {
          // The helper captured but the sidecar did not publish: helper → Electron publishing.
          logCapture(`[sidecar] fallback to Electron publishing (${pub.why})`);
          args = electronArgs;
          result = await wgc.start(args);
        } else {
          // The helper itself failed (e.g. 150 % scaling timeout): retrying it would only
          // burn another 8 s, so the class window falls back to Chromium capture now.
          logCapture(`[sidecar] helper failed (${result.error}); class window falls back to Chromium capture`);
        }
      }
    } else {
      sidecarInitLine = null;
      result = await wgc.start(args);
    }
    if (!result.ok) {
      console.log(`[capture] native Windows.Graphics.Capture failed: ${result.error}`);
      lastWgcArgs = null;
      return result;
    }
    lastWgcArgs = args;
    if (body.kind === 'window') {
      captureTarget = { kind: 'window', hwnd: args[1]! };
    } else {
      const m = { x: Number(args[1]), y: Number(args[2]), w: Number(args[3]) - Number(args[1]), h: Number(args[4]) - Number(args[2]) };
      captureTarget = { kind: 'monitor', displayId: String(body.displayId ?? ''), rect: m };
    }
    supervisor.arm(captureTarget, SCREEN_SHARE.capture.frameRate);
    if (result.monitor && result.monitor.w > 0 && result.monitor.h > 0) testMonitor = result.monitor;
    const fallbackDisplay = typeof body.displayId === 'string' ? body.displayId : '';
    const displayId = displayIdForCapturedMonitor(result.monitor, fallbackDisplay);
    const capturedDisplay = screen.getAllDisplays().find((d) => String(d.id) === displayId);
    if (capturedDisplay && capturedDisplay.scaleFactor > 0) inkScale = capturedDisplay.scaleFactor;
    const line = `[capture] publishing Windows.Graphics.Capture native ${result.width}x${result.height} source=${result.source} display=${displayId} cursor=${result.cursor} borderOff=${result.borderOff} controlProtected=${protectedOk} mask=false`;
    console.log(line);
    plan = {
      ...plan,
      label: LABEL_WGC,
      detail: `${LABEL_WGC}. control protected=${protectedOk}. ${result.api} ${result.width}x${result.height} source=${result.source} display=${displayId} cursor=${result.cursor} borderOff=${result.borderOff}.`,
    };
    if (publisher === 'sidecar' && inkLayer) wgc.send(inkMessage(inkLayer));
    return {
      ...result,
      publisher,
      displayId,
      affinityOk: protectedOk ? 1 : 0,
      affinityFail: protectedOk ? 0 : 1,
      label: plan.label,
      detail: plan.detail,
    };
  });

  ipcMain.handle('stop-wgc', async () => {
    supervisor.disarm();
    captureTarget = null;
    inkLayer = null;
    inkDirty = true;
    if (sidecarActive()) {
      // Let the sidecar unpublish and leave the room cleanly first.
      wgc.send(controlLine({ op: 'stop' }));
      await new Promise((r) => setTimeout(r, 700));
      sidecarInitLine = null;
      sidecarPublished = false;
    }
    sidecarTokenPath = null;
    wgc.stop();
    return { ok: true };
  });

  ipcMain.handle('adopt-mask', (_e, reason: unknown) => {
    const why = typeof reason === 'string' && reason ? reason : 'Windows.Graphics.Capture did not start';
    logCapture(`[capture] refused blackout mask: ${why}`);
    return plan;
  });

  ipcMain.handle('capture-test-open', () => {
    openCaptureTestWindow();
    return { ok: true };
  });

  ipcMain.handle('capture-test-start', () => startCaptureTest());

  ipcMain.handle('capture-test-stop', () => {
    stopCaptureTest();
    return { ok: true };
  });

  ipcMain.handle('capture-diagnostics', () => diagnostics());

  ipcMain.handle('capture-diff', () => runCaptureDiff());

  ipcMain.handle('capture-scenario', async () => {
    if (testRunning) {
      testRunning = false;
      if (!lastSnap?.hud.sharing) wgc.stop();
    }
    const report = await runNotepadCaptureScenario();
    if (report.verdict === 'pass') localCaptureProven = true;
    else if (report.verdict === 'fail') localCaptureProven = false;
    return report;
  });

  ipcMain.handle('annotation-open', (_event, displayId: unknown) => {
    openAnnotationOverlay(displayId);
    return { ok: true };
  });

  ipcMain.handle('annotation-close', () => {
    closeAnnotationOverlay();
    return { ok: true };
  });

  ipcMain.on('annotation-active', (_event, on: unknown) => {
    annotateOn = on === true;
    if (annotateOn) openAnnotateTools();
    else closeAnnotateTools();
    setOverlayDrawing(annotateOn);
  });

  // Tool panel: Draw ↔ Click-through without closing the panel.
  ipcMain.on('annotation-draw-mode', (event, on: unknown) => {
    const tools = chrome.get('annotate-tools');
    if (!tools || tools.isDestroyed() || event.sender !== tools.webContents) return;
    if (!annotateOn) return;
    setOverlayDrawing(on === true);
  });

  // Student desktop ink (from the class window) → the captured overlay.
  ipcMain.on('student-ink', (event, ink: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    if (!ink || typeof ink !== 'object') return;
    lastStudentInk = ink;
    const win = chrome.get('annotate-overlay');
    if (win && !win.isDestroyed() && !win.webContents.isLoading()) win.webContents.send('student-ink', ink);
  });

  // Video mode: restart the helper with the same source at a new capture rate.
  ipcMain.handle('wgc-fps', async (event, fps: unknown) => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return { ok: false };
    if (!lastWgcArgs || !lastSnap?.hud.sharing) return { ok: false };
    const rate = Math.max(1, Math.min(30, Math.round(Number(fps) || SCREEN_SHARE.capture.frameRate)));
    requestedShareFps = rate;
    if (sidecarActive()) return { ok: wgc.send(controlLine({ op: 'fps', fps: levelProfile(adaptive.level, rate, layerSize.h || 1080).fps })) };
    const args = [...lastWgcArgs];
    if (args[args.length - 1] === String(rate)) return { ok: true };
    args[args.length - 1] = String(rate);
    const result = await wgc.start(args);
    if (!result.ok) {
      logCapture(`[capture] fps change to ${rate} failed: ${result.error}; back to ${lastWgcArgs[lastWgcArgs.length - 1]}`);
      await wgc.start(lastWgcArgs);
      return { ok: false };
    }
    lastWgcArgs = args;
    if (captureTarget) supervisor.arm(captureTarget, rate);
    logCapture(`[capture] capture rate ${rate} fps`);
    return { ok: true };
  });

  // Class window → sidecar: Video mode (frame rate) and share sound on/off.
  ipcMain.on('sidecar-control', (event, msg: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || !sidecarActive()) return;
    const m = msg as { op?: unknown; videoMode?: unknown; on?: unknown } | null;
    if (m?.op === 'mode') {
      sidecarVideoMode = m.videoMode === true;
      wgc.send(controlLine({ op: 'mode', videoMode: sidecarVideoMode }));
    } else if (m?.op === 'audio') {
      sidecarAudioOn = m.on === true;
      wgc.send(controlLine({ op: 'audio', on: sidecarAudioOn }));
    }
  });

  ipcMain.on('annotation-command', (_event, cmd: unknown) => {
    if (!cmd || typeof cmd !== 'object') return;
    sendOverlay('annotate-command', cmd);
  });

  ipcMain.on('annotation-ink', (_event, shapes: unknown) => {
    replaceInk(shapes);
  });

  // The overlay's rendered ink (teacher annotations + student desktop ink),
  // already at the published frame size. Composited into each frame so it
  // reaches students whether or not WGC captures the layered overlay window.
  ipcMain.on('annotation-layer', (event, raw: unknown) => {
    const win = chrome.get('annotate-overlay');
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    inkLayer = parseInkLayer(raw);
    if (sidecarActive()) {
      wgc.send(inkMessage(inkLayer));
      return;
    }
    kickInk();
  });

  ipcMain.on('video-tile', (event, key: unknown, jpeg: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    if (typeof key !== 'string' || !key || key.length > 240) return;
    const size = jpeg instanceof ArrayBuffer ? jpeg.byteLength : jpeg instanceof Uint8Array ? jpeg.byteLength : 0;
    if (!size || size > 200_000) return;
    const win = chrome.get('classroom-videos');
    if (!win || win.isDestroyed()) return;
    win.webContents.send('video-tile', key, jpeg);
  });

  // Teacher eraser / clear over student ink → the class window posts to /draw.
  ipcMain.on('student-ink-erase', (event, ids: unknown) => {
    const overlay = chrome.get('annotate-overlay');
    if (!overlay || overlay.isDestroyed() || event.sender !== overlay.webContents) return;
    if (!Array.isArray(ids)) return;
    const clean = ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 40).slice(0, 100);
    if (clean.length && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('student-ink-edit', { erase: clean });
  });
  ipcMain.on('student-ink-clear', (event) => {
    const tools = chrome.get('annotate-tools');
    if (!tools || tools.isDestroyed() || event.sender !== tools.webContents) return;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('student-ink-edit', { clear: true });
  });

  ipcMain.on('annotation-status', (_event, status: unknown) => {
    for (const win of [toolbar, chrome.get('annotate-tools')]) {
      if (win && !win.isDestroyed()) win.webContents.send('annotate-status', status);
    }
  });

  ipcMain.on('mouse-passthrough', (event, on: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    win.setIgnoreMouseEvents(on === true, { forward: true });
  });

  ipcMain.handle('displays', () =>
    screen.getAllDisplays().map((d) => ({
      id: d.id,
      scaleFactor: d.scaleFactor,
      x: d.bounds.x,
      y: d.bounds.y,
      w: d.bounds.width,
      h: d.bounds.height,
    }))
  );

  ipcMain.handle('confirm-end', async () => {
    // B2 (live test 2026-10-17): this used to bail out on lastSnap.hud.sharing, a HUD
    // snapshot that lags a few seconds behind Stop sharing, so End class was ignored.
    // The class window already refuses End while it is really sharing.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    const options = {
      type: 'warning' as const,
      buttons: ['End class', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'End class',
      message: 'End the class for everyone?',
      detail: 'Students are disconnected and the class closes. To step out but keep the class running, use Leave.',
    };
    const choice =
      mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
    return choice.response === 0;
  });

  ipcMain.handle('save-hotkeys', (_e, hotkeys: unknown) => {
    if (!hotkeys || typeof hotkeys !== 'object') return { ok: false, error: 'Invalid shortcuts.' };
    const h = hotkeys as Partial<Hotkeys>;
    const next: Hotkeys = {
      mic: typeof h.mic === 'string' && h.mic.trim() ? h.mic.trim() : config.hotkeys.mic,
      camera: typeof h.camera === 'string' && h.camera.trim() ? h.camera.trim() : config.hotkeys.camera,
      stopShare: typeof h.stopShare === 'string' && h.stopShare.trim() ? h.stopShare.trim() : config.hotkeys.stopShare,
    };
    config.hotkeys = next;
    saveConfig();
    registerHotkeys();
    return { ok: true };
  });

  ipcMain.handle('save-layout', (_e, slots: unknown) => {
    if (typeof slots === 'number' && isSlotCount(slots)) {
      config.layout = slots;
      saveConfig();
      resizeVideos();
    }
  });

  ipcMain.handle('save-devices', (_e, micId: unknown, camId: unknown) => {
    if (typeof micId === 'string') config.micId = micId;
    if (typeof camId === 'string') config.camId = camId;
    saveConfig();
  });

  ipcMain.on('push-hud', (event, snap: unknown) => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return;
    if (!snap || typeof snap !== 'object') return;
    const next = snap as PanelSnapshot;
    if (Array.isArray(next.messages) && next.messages.length > 100) next.messages = next.messages.slice(-100);
    const wasSharing = lastSnap?.hud.sharing === true;
    lastSnap = next;
    for (const win of chrome.values()) sendHud(win);
    refreshTray();
    if (next.hud?.sharing && !wasSharing) showToolbar();
    if (wasSharing && next.hud && !next.hud.sharing) {
      hideShareChrome();
      restoreMain();
    }
  });

  ipcMain.on('action', (_event, action: unknown) => {
    if (isTeacherAction(action)) forward(action);
  });

  ipcMain.on('toolbar-size', (_event, w: unknown, h: unknown) => {
    if (!toolbar || toolbar.isDestroyed()) return;
    const width = Math.max(48, Math.min(1600, Math.round(Number(w))));
    const height = Math.max(44, Math.min(420, Math.round(Number(h))));
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    const b = toolbar.getBounds();
    toolbar.setContentSize(width, height);
    toolbar.setPosition(b.x, b.y);
    publishBounds();
  });

  ipcMain.on('toggle-panel', (_event, kind: unknown) => {
    if (typeof kind === 'string') togglePanel(kind);
  });

  ipcMain.on('minimize-main', () => {
    showToolbar();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
    publishBounds();
  });

  ipcMain.on('restore-main', () => restoreMain());

  ipcMain.on('notify', (_event, title: unknown, body: unknown) => {
    if (typeof title !== 'string' || typeof body !== 'string') return;
    if (Notification.isSupported()) {
      const n = new Notification({
        title: title.slice(0, 80),
        body: body.slice(0, 180),
        icon: windowIcon(iconDir()),
      });
      n.on('click', () => restoreMain());
      n.show();
    }
    alerted = true;
    refreshTray();
  });

  ipcMain.on('class-active', (_event, on: unknown) => {
    classActive = on === true;
    registerHotkeys();
    rebuildTrayMenu();
    refreshTray();
  });
}

function installCapturePermission(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture' || permission === 'notifications');
  });
  ses.setPermissionCheckHandler((_wc, permission) => {
    const name = String(permission);
    return name === 'media' || name === 'display-capture';
  });
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 },
      });
      const want = pendingSource;
      let found = want ? sources.find((s) => s.id === want.id) : undefined;
      if (!found && want?.kind === 'screen' && want.displayId) {
        found = sources.find((s) => s.display_id === want.displayId);
      }
      if (!found && want?.name) {
        const prefix = want.kind === 'screen' ? 'screen:' : 'window:';
        found = sources.find((s) => s.name === want.name && s.id.startsWith(prefix));
      }
      const audioRequested = Boolean((request as { audioRequested?: boolean }).audioRequested);
      const video = found || sources.find((s) => s.id.startsWith('screen:')) || sources[0];
      if (!video) {
        callback({});
        return;
      }
      callback(audioRequested ? { video, audio: 'loopback' } : { video });
    } catch {
      callback({});
    }
  });
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 860,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    icon: windowIcon(iconDir()),
    webPreferences: prefs(),
  });
  watch(mainWindow, 'main');
  attachChildWindows(mainWindow);
  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return;
    protectExcludedWindow(mainWindow, 'main');
    mainWindow.show();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  for (const ev of ['show', 'hide', 'minimize', 'restore'] as const) mainWindow.on(ev as 'show', reportPanels);
  mainWindow.webContents.on('did-finish-load', reportPanels);
  void mainWindow.loadURL('app://classroom/engine.html');
}

async function start(): Promise<void> {
  loadConfig();
  api = new ClassroomApi({
    current: config,
    save: saveConfig,
  });
  plan = readProbe();
  installProtocol();
  installCapturePermission();
  installIpc();
  createMainWindow();
  createTray();
  app.on('second-instance', () => restoreMain());
  app.on('activate', () => {
    if (!mainWindow) createMainWindow();
    else restoreMain();
  });
  // Display / session changes can leave the WGC session frozen: restart it.
  screen.on('display-added', () => supervisor.trigger('display-added'));
  screen.on('display-removed', () => supervisor.trigger('display-removed'));
  for (const ev of ['unlock-screen', 'resume', 'user-did-become-active'] as const) {
    try {
      powerMonitor.on(ev as 'resume', () => supervisor.trigger(ev));
    } catch {
      /* event not supported on this platform */
    }
  }
  screen.on('display-metrics-changed', (_event, display, changed) => {
    if (changed.some((m) => m === 'bounds' || m === 'scaleFactor' || m === 'rotation')) supervisor.trigger('display-metrics-changed');
    resizeVideos();
    if (overlayDisplayId != null && display.id === overlayDisplayId) placeAnnotationOverlay();
  });
  screen.on('display-removed', () => {
    if (overlayDisplayId == null) return;
    if (screen.getAllDisplays().some((d) => d.id === overlayDisplayId)) return;
    overlayDisplayId = screen.getPrimaryDisplay().id;
    placeAnnotationOverlay();
    raiseControls();
  });
  app.on('will-quit', () => {
    wgc.stop();
    globalShortcut.unregisterAll();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

if (gotLock) {
  void app.whenReady().then(start);
}

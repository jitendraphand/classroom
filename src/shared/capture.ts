/**
 * Capture path.
 *
 * Windows 10 2004 (build 19041) and later: each opaque classroom window calls
 * BrowserWindow.setContentProtection(true) inside the Electron process.
 * That calls SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE = 0x11) on that
 * window's own HWND. Windows.Graphics.Capture then omits the window and the
 * frame contains the pixels behind it.
 *
 * The transparent annotation overlay is not excluded. On a normal desktop
 * that overlay is already in the Windows.Graphics.Capture texture, so the
 * published class frame is not also painted with the same strokes. The
 * capture-test scorer still burns them in, because a Remote Desktop session
 * without a GPU left the layered overlay out of the texture. The region
 * picker is transparent and full-monitor.
 * Excluding a layered window composites as a black rectangle, so that picker
 * stays unprotected and closes before the share starts. A separate process
 * must not call SetWindowDisplayAffinity on these HWNDs. Canvas blackout is
 * never used. If Graphics Capture cannot start, the share is refused.
 *
 * planMask remains for geometry tests. Nothing in the publisher calls it.
 */

import { videoGrid, type SlotCount } from './classLogic';

export const WIN10_2004_BUILD = 19041;
/** SetWindowDisplayAffinity value introduced in Windows 10 2004. */
export const WDA_EXCLUDEFROMCAPTURE = 0x11;
export const WDA_NONE = 0;

export type CaptureMode = 'wgc-exclude' | 'unavailable';

/** Shown in the toolbar and the class window so a tester can report the path. */
export const LABEL_WGC = 'Windows.Graphics.Capture, classroom windows excluded';
export const LABEL_UNAVAILABLE = 'screen share unavailable until Windows.Graphics.Capture starts';

export type CapturePlan = {
  mode: CaptureMode;
  /**
   * The value Electron's setContentProtection uses on Windows 10 2004+
   * (WDA_EXCLUDEFROMCAPTURE). It is not passed to another process.
   */
  affinity: number;
  /**
   * Always false. Kept so a caller cannot silently turn a blackout mask back on.
   * The publisher refuses to share when this is true.
   */
  mask: boolean;
  /** One sentence: which path students are on. */
  label: string;
  /** Label plus build, helper, and affinity counts. */
  detail: string;
};

export type WgcStartOk = {
  ok: true;
  width: number;
  height: number;
  cursor: boolean;
  borderOff: boolean;
  source: string;
  api: string;
  /** Electron display id of the monitor that was captured. Empty if none matched. */
  displayId: string;
  affinityOk: number;
  affinityFail: number;
  label: string;
  detail: string;
  /** Who publishes the share: the native sidecar, or the class window (Electron). */
  publisher?: 'sidecar' | 'electron';
};

export type WgcStartResult = WgcStartOk | { ok: false; error: string };

export function capturePlan(
  probe: { build: number; wgc: boolean } | null | undefined,
  detail?: string
): CapturePlan {
  if (probe && probe.build >= WIN10_2004_BUILD && probe.wgc) {
    return {
      mode: 'wgc-exclude',
      affinity: WDA_EXCLUDEFROMCAPTURE,
      mask: false,
      label: LABEL_WGC,
      detail: detail || `${LABEL_WGC}. Windows build ${probe.build}, Graphics Capture supported.`,
    };
  }
  return {
    mode: 'unavailable',
    affinity: WDA_EXCLUDEFROMCAPTURE,
    mask: false,
    label: LABEL_UNAVAILABLE,
    detail:
      detail ||
      `${LABEL_UNAVAILABLE}. Nothing is shared, and classroom panels are not painted into the picture.`,
  };
}

export type Rect = { x: number; y: number; w: number; h: number };
export type ScreenGeom = { left: number; top: number; width: number; height: number };
export type FrameSize = { width: number; height: number };
export type PhysicalBox = { x: number; y: number; w: number; h: number };

/**
 * Which display owns this monitor rectangle. Both sides are physical pixels
 * (the same space as GetMonitorInfo.rcMonitor and dipToScreenRect), so a
 * 150% monitor beside a 100% primary is not multiplied by its scale again.
 * Each edge may differ by `tolerance` pixels.
 */
export function matchPhysicalDisplay(
  displays: ReadonlyArray<{ id: string | number; x: number; y: number; w: number; h: number }>,
  rect: PhysicalBox,
  tolerance = 8
): string {
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !(rect.w > 0) || !(rect.h > 0)) return '';
  for (const display of displays) {
    if (!(display.w > 0) || !(display.h > 0)) continue;
    const left = Math.abs(display.x - rect.x);
    const top = Math.abs(display.y - rect.y);
    const right = Math.abs(display.x + display.w - (rect.x + rect.w));
    const bottom = Math.abs(display.y + display.h - (rect.y + rect.h));
    if (left <= tolerance && top <= tolerance && right <= tolerance && bottom <= tolerance) return String(display.id);
  }
  return '';
}

export const MASK_MARGIN_DIP = 16;
export const MASK_TRAIL_MS = 350;

export function aspectMatches(screen: ScreenGeom, frame: FrameSize, tolerance = 0.03): boolean {
  if (!screen.width || !screen.height || !frame.width || !frame.height) return false;
  const a = screen.width / screen.height;
  const b = frame.width / frame.height;
  return Math.abs(a - b) / a <= tolerance;
}

export function candidateScreens(screens: ScreenGeom[], frame: FrameSize): ScreenGeom[] {
  return screens.filter((s) => aspectMatches(s, frame));
}

export function windowRectOnFrame(
  win: Rect,
  screen: ScreenGeom,
  frame: FrameSize,
  marginDip = MASK_MARGIN_DIP
): Rect | null {
  if (!screen.width || !screen.height) return null;
  const sx = frame.width / screen.width;
  const sy = frame.height / screen.height;
  const x0 = Math.floor((win.x - marginDip - screen.left) * sx);
  const y0 = Math.floor((win.y - marginDip - screen.top) * sy);
  const x1 = Math.ceil((win.x + win.w + marginDip - screen.left) * sx);
  const y1 = Math.ceil((win.y + win.h + marginDip - screen.top) * sy);
  const cx0 = Math.max(0, x0);
  const cy0 = Math.max(0, y0);
  const cx1 = Math.min(frame.width, x1);
  const cy1 = Math.min(frame.height, y1);
  if (cx1 <= cx0 || cy1 <= cy0) return null;
  return { x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 };
}

export function validWindowRect(win: Partial<Rect> | null | undefined): win is Rect {
  return (
    !!win &&
    [win.x, win.y, win.w, win.h].every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    (win.w as number) > 0 &&
    (win.h as number) > 0
  );
}

export type MaskPlan =
  | { kind: 'rects'; rects: Rect[] }
  | { kind: 'unsafe' };

/**
 * Where to black out `wins` on this frame. Every screen that could be the
 * captured one is masked (two identical monitors → both spots).
 *
 * `trustZeroOrigin` is true on Windows, where (0, 0) is a real corner of the
 * primary monitor. The browser mask treats (0, 0) as "position unknown"
 * because Wayland reports that for every window.
 */
export function planMask(
  wins: ReadonlyArray<Partial<Rect> | null | undefined>,
  screens: ScreenGeom[],
  frame: FrameSize,
  opts: { trustZeroOrigin?: boolean; marginDip?: number } = {}
): MaskPlan {
  const list = wins.filter(validWindowRect);
  if (!list.length) return { kind: 'rects', rects: [] };
  if (!opts.trustZeroOrigin && list.some((w) => w.x === 0 && w.y === 0)) return { kind: 'unsafe' };
  const candidates = candidateScreens(screens, frame);
  if (!candidates.length) return { kind: 'unsafe' };
  const rects: Rect[] = [];
  for (const win of list) {
    for (const s of candidates) {
      const r = windowRectOnFrame(win, s, frame, opts.marginDip ?? MASK_MARGIN_DIP);
      if (r) rects.push(r);
    }
  }
  return { kind: 'rects', rects };
}

/** Recent window rects stay masked so a fast drag cannot outrun the capture. */
export class RectTrail {
  private items: Array<{ t: number; rects: Rect[] }> = [];
  constructor(private trailMs = MASK_TRAIL_MS) {}
  push(t: number, rects: Rect[]): Rect[] {
    this.items.push({ t, rects });
    this.items = this.items.filter((i) => t - i.t <= this.trailMs);
    const out: Rect[] = [];
    for (const i of this.items) out.push(...i.rects);
    return out;
  }
}

export type SideKind = 'chat' | 'roster' | 'videos' | 'devices';
export type Box = { x: number; y: number; w: number; h: number };
export type Avail = { left: number; top: number; width: number; height: number };
export type Size = { w: number; h: number };

/** Left-to-right from the toolbar's right edge (first = rightmost). */
export const SIDE_ORDER: SideKind[] = ['chat', 'roster', 'devices', 'videos'];
export const SIDE_GAP = 8;

export const SIDE_SIZE: Record<SideKind, Size> = {
  chat: { w: 340, h: 460 },
  roster: { w: 380, h: 520 },
  devices: { w: 320, h: 280 },
  videos: { w: 640, h: 420 },
};

/**
 * Tile width is about 1/6 of the work-area width, 16:9, clamped so a face
 * stays readable and a wide monitor does not grow a huge mosaic.
 * On 1920×1080 that is 320×180, close to the web class panel (354×199).
 * The old 1/20 size (96×54) was too small to use.
 */
export const VIDEO_TILE_DIVISOR = 6;
export const VIDEO_TILE_MIN = 200;
export const VIDEO_TILE_MAX = 360;
export const VIDEO_GAP = 4;
export const VIDEO_PAD = 2;
/** Drag grip above the tiles. Matches the videos window CSS. */
export const VIDEO_GRIP = 14;

/**
 * Face size for the floating student-video window only. A non-positive width
 * falls back to 1920. The meeting film does not use this: it fills the left
 * column with fractional tracks (see dockGridStyle).
 */
export function dockTilePx(screenWidth: number): { w: number; h: number } {
  const width = Number.isFinite(screenWidth) && screenWidth > 0 ? screenWidth : 1920;
  const w = Math.round(Math.min(VIDEO_TILE_MAX, Math.max(VIDEO_TILE_MIN, width / VIDEO_TILE_DIVISOR)));
  const h = Math.round((w * 9) / 16);
  return { w, h };
}

/** Prefer the screen work area, then the window, then 1920. */
export function cssScreenWidth(availWidth: number | undefined, innerWidth: number | undefined): number {
  if (typeof availWidth === 'number' && Number.isFinite(availWidth) && availWidth > 0) return availWidth;
  if (typeof innerWidth === 'number' && Number.isFinite(innerWidth) && innerWidth > 0) return innerWidth;
  return 1920;
}

/**
 * Meeting-screen tracks. Column and row counts stay videoGrid(..., 'dock'):
 * 2 is 1×2, 4 is 1×4, 6 is 2×3. Each track is a fraction of the film, so the
 * grid fills the left column instead of sitting at a fixed face size.
 */
export function dockGridStyle(slots: SlotCount): { gridTemplateColumns: string; gridTemplateRows: string } {
  const spec = videoGrid(slots);
  return {
    gridTemplateColumns: `repeat(${spec.cols}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${spec.rows}, minmax(0, 1fr))`,
  };
}

/**
 * Window size for the floating student videos. Tile width follows dockTilePx
 * (about 1/6 of the work area, 16:9). A 200% display and a 100% display of the
 * same logical size get the same fraction. The panel is only the grid plus the
 * grip and a 2px pad. If that rectangle would not fit the work area, tiles
 * shrink, still 16:9.
 */
export function videoPanelSize(
  workArea: { width: number; height: number },
  slots: SlotCount
): { w: number; h: number; tileW: number; tileH: number } {
  const tile = dockTilePx(workArea.width);
  let tileW = tile.w;
  let tileH = tile.h;
  const grid = videoGrid(slots, 'share');
  const chromeW = (grid.cols - 1) * VIDEO_GAP + VIDEO_PAD * 2;
  const chromeH = (grid.rows - 1) * VIDEO_GAP + VIDEO_PAD * 2 + VIDEO_GRIP;
  const maxW = Math.max(chromeW + grid.cols * 2, workArea.width);
  const maxH = Math.max(chromeH + grid.rows * 2, workArea.height);
  const fitW = Math.floor((maxW - chromeW) / grid.cols);
  const fitH = Math.floor((maxH - chromeH) / grid.rows);
  if (tileW > fitW) {
    tileW = Math.max(2, fitW);
    tileH = Math.max(2, Math.round((tileW * 9) / 16));
  }
  if (tileH > fitH) {
    tileH = Math.max(2, fitH);
    tileW = Math.max(2, Math.round((tileH * 16) / 9));
  }
  return {
    w: grid.cols * tileW + chromeW,
    h: grid.rows * tileH + chromeH,
    tileW,
    tileH,
  };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Where to open `kind`. The toolbar itself is never moved.
 * Without a toolbar box, windows sit at the bottom-right of the available area.
 */
export function sideWindowBox(
  kind: SideKind,
  toolbar: Box | null,
  avail: Avail,
  sizes: Partial<Record<SideKind, Size>> = {}
): { left: number; top: number; w: number; h: number } {
  const size = (k: SideKind) => sizes[k] ?? SIDE_SIZE[k];
  const me = size(kind);
  const w = Math.min(me.w, Math.max(120, avail.width));
  const h = Math.min(me.h, Math.max(80, avail.height));
  let offset = 0;
  for (const k of SIDE_ORDER) {
    if (k === kind) break;
    offset += size(k).w + SIDE_GAP;
  }
  const availRight = avail.left + avail.width;
  const availBottom = avail.top + avail.height;
  if (!toolbar) {
    return {
      left: clamp(availRight - SIDE_GAP - offset - w, avail.left, Math.max(avail.left, availRight - w)),
      top: clamp(availBottom - SIDE_GAP - h, avail.top, Math.max(avail.top, availBottom - h)),
      w,
      h,
    };
  }
  const right = toolbar.x + toolbar.w - offset;
  const roomAbove = toolbar.y - SIDE_GAP - avail.top;
  const roomBelow = availBottom - (toolbar.y + toolbar.h + SIDE_GAP);
  const top =
    roomAbove >= h || roomAbove >= roomBelow ? toolbar.y - SIDE_GAP - h : toolbar.y + toolbar.h + SIDE_GAP;
  return {
    left: clamp(right - w, avail.left, Math.max(avail.left, availRight - w)),
    top: clamp(top, avail.top, Math.max(avail.top, availBottom - h)),
    w,
    h,
  };
}

/** Screen-share simulcast only when the capture is clearly larger than 720p. */
export function screenShareSimulcastFor(width: number | undefined, height: number | undefined): boolean {
  if (!SCREEN_SHARE.layers.length) return false;
  if (!width || !height) return false;
  return Math.min(width, height) >= 720 * 1.25;
}

export const TEACHER_CAMERA = {
  /** Faces in a small tile: 360p / 15 fps, one layer ≤300 kbps (web TEACHER_CAMERA). */
  capture: { width: 640, height: 360, frameRate: 15 },
  encoding: { maxBitrate: 300_000, maxFramerate: 15 },
  layers: [] as { width: number; height: number; maxBitrate: number; maxFramerate: number }[],
  simulcast: false,
} as const;

export const SCREEN_SHARE = {
  /**
   * One 720p layer at 8 fps. A second simulcast layer would encode the desktop
   * twice, and 1080p/15 made the host spend most of its time on readback.
   * Slides stay sharp at this rate; the pointer is a little less smooth.
   * 720p is also the floor: published as VP9 L1T3 (frame rate degrades,
   * resolution never) with a VP8 backup codec, like the website.
   */
  capture: { width: 1280, height: 720, frameRate: 8 },
  encoding: { maxBitrate: 700_000, maxFramerate: 8 },
  layers: [] as { width: number; height: number; maxBitrate: number; maxFramerate: number }[],
} as const;

export type ShareKind = 'screen' | 'window' | 'region';

/**
 * Video mode (the website's share "Video" toggle, shared/web/videoQuality.ts
 * SCREEN_SHARE_VIDEO_MODE): manual only, 720p / 30 fps (the toolbar promises
 * "smooth 30 fps"; run 3 measured 4-8 fps, see SIDECAR_HELPER_FPS), `motion` hint,
 * resolution kept under pressure (maintain-resolution). The picture stays 1280x720 (this app's single layer),
 * so the bitrate sits between the web's 720p30 layer (1 Mbps) and its 1080p30
 * top layer (2.5 Mbps). The helper's capture rate is raised to 30 for as long
 * as video mode is on; that is ~3.7x the slide readback, see REPORT.md.
 */
export const VIDEO_MODE_SHARE = {
  capture: { width: 1280, height: 720, frameRate: 30 },
  encoding: { maxBitrate: 1_500_000, maxFramerate: 30 },
} as const;

/**
 * Capture rate the WGC helper is started with when the native sidecar
 * publishes. The helper's rate is fixed at spawn (its stdin is not wired
 * through the sidecar), and the sidecar only paces what it gets: the helper
 * used to start at the slide rate (8 fps), so Video mode could never exceed
 * 8 fps (run 3: 4-8 fps). The helper now runs at the Video mode rate and the
 * sidecar pacer keeps slides at 8 fps. WGC only delivers changed frames, so a
 * still slide still costs nothing; a moving pointer costs more readbacks.
 */
export const SIDECAR_HELPER_FPS = VIDEO_MODE_SHARE.capture.frameRate;

/** Sender encodings for slides (this app's SCREEN_SHARE) or video mode. Other fields are kept. */
export function windowsShareEncodings<E extends { maxBitrate?: number; maxFramerate?: number }>(encodings: E[], videoMode: boolean): E[] {
  const top = videoMode ? VIDEO_MODE_SHARE.encoding : SCREEN_SHARE.encoding;
  const list = encodings.length ? encodings : [{} as E];
  return list.map((e, i) => {
    const low = i < list.length - 1 ? SCREEN_SHARE.layers[i] : undefined;
    const layer = low && !videoMode ? low : top;
    return { ...e, maxBitrate: layer.maxBitrate, maxFramerate: layer.maxFramerate };
  });
}

/**
 * Where the shared picture sits on the overlay's monitor, 0..1. Student ink is
 * normalised to the shared picture (web drawLogic), so a region share maps
 * into the region; a screen or window share (whole monitor) maps 1:1.
 */
export function inkRectFor(
  kind: ShareKind,
  region: { x: number; y: number; w: number; h: number } | null,
  display: { x: number; y: number; w: number; h: number } | null
): { x: number; y: number; w: number; h: number } {
  if (kind !== 'region' || !region || !display || !(display.w > 0) || !(display.h > 0)) return { x: 0, y: 0, w: 1, h: 1 };
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const x = clamp((region.x - display.x) / display.w);
  const y = clamp((region.y - display.y) / display.h);
  const w = clamp(region.w / display.w);
  const h = clamp(region.h / display.h);
  return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
}

/**
 * Transparent windows that must stay in the capture.
 * annotate-overlay carries the strokes. region-picker is a layered full-monitor
 * surface; excluding it paints a black rectangle over the desktop.
 */
const CAPTURE_VISIBLE_WINDOWS = new Set(['annotate-overlay', 'region-picker']);

/**
 * Every classroom window, decided one by one (REPORT.md "Window protection").
 * `false` = capture-excluded (setContentProtection / WDA_EXCLUDEFROMCAPTURE),
 * `true` = in the shared picture. tests/windowProtection.test.ts keeps this
 * list and windowShouldBeCaptureExcluded() in step.
 */
export const WINDOW_CAPTURE_DECISIONS: Record<string, { captured: boolean; why: string }> = {
  main: { captured: false, why: 'Class window (minimised during a share).' },
  toolbar: { captured: false, why: 'Floating control panel.' },
  chat: { captured: false, why: 'Messages panel.' },
  roster: { captured: false, why: 'People panel (draw requests, Allow / Revoke).' },
  devices: { captured: false, why: 'Microphone / camera picker.' },
  'classroom-videos': { captured: false, why: 'Student videos (canvas tiles).' },
  'annotate-tools': { captured: false, why: 'Annotation tool panel: opaque, so exclusion is clean.' },
  'annotate-preview': { captured: false, why: 'Opaque preview popup.' },
  'capture-test': { captured: false, why: 'Capture test window.' },
  'annotate-overlay': {
    captured: true,
    why: 'Transparent ink overlay. Excluding a layered transparent window composites as a black rectangle on Windows 10. Its ink is ALSO composited into the published frames by main (shared/inkLayer.ts) unless the captured frame already shows it.',
  },
  'region-picker': { captured: true, why: 'Transparent picker; closes before the share starts. Excluding it paints black.' },
};

/**
 * Every other classroom window is capture-excluded: the control panel, the
 * main window, roster, messages, devices, videos, the capture test, and any
 * later opaque popup. An empty name is left alone.
 */
export function windowShouldBeCaptureExcluded(name: string): boolean {
  return name.length > 0 && !CAPTURE_VISIBLE_WINDOWS.has(name);
}

/** Window titles offered in the share picker. Classroom windows are not sources. */
export function isOfferedShareWindow(name: string): boolean {
  return !/classroom teacher|share controls|student videos|annotate|choose a region|capture test/i.test(name);
}

/**
 * Sharing is never refused on capability grounds (2026-10-18). When
 * Windows.Graphics.Capture can exclude the classroom panels it is used; when it
 * cannot, the share falls back to Chromium desktop capture, which may show the
 * protected panels as black boxes, rather than sharing nothing.
 */
export function shareAllowed(
  _plan: CapturePlan,
  _kind: ShareKind
): { ok: true } | { ok: false; reason: string } {
  return { ok: true };
}

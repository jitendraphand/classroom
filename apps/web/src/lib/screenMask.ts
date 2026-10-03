/**
 * Geometry for the whole-screen share blackout mask (see screenMaskPipeline.ts).
 *
 * Window and screen positions come from the browser in screen DIPs (device
 * independent pixels) in one virtual desktop space: `win.screenX/screenY/
 * outerWidth/outerHeight` and, with the Window Management API, each screen's
 * `left/top/width/height`. A monitor capture is that one screen scaled to the
 * frame size, so frame px = (dip - screen origin) * (frame size / screen size).
 * The ratio already folds in devicePixelRatio and any capture downscale
 * (e.g. a 4K/2x panel captured at 1080p).
 *
 * Pure and dependency-free so it is unit-tested (tests/screenMask.test.ts).
 */

export type Rect = { x: number; y: number; w: number; h: number };
export type ScreenGeom = { left: number; top: number; width: number; height: number };
export type FrameSize = { width: number; height: number };

/** Extra DIPs blacked out around the window (shadow, title bar, capture lag). */
export const MASK_MARGIN_DIP = 16;
/** Recent window rects stay masked this long, so a fast drag cannot outrun the capture. */
export const MASK_TRAIL_MS = 350;

/** Capture keeps the screen's aspect ratio; a mismatch means the frame is not this screen. */
export function aspectMatches(screen: ScreenGeom, frame: FrameSize, tolerance = 0.03): boolean {
  if (!screen.width || !screen.height || !frame.width || !frame.height) return false;
  const a = screen.width / screen.height;
  const b = frame.width / frame.height;
  return Math.abs(a - b) / a <= tolerance;
}

/** Screens that could be the captured monitor (the capture does not say which one). */
export function candidateScreens(screens: ScreenGeom[], frame: FrameSize): ScreenGeom[] {
  return screens.filter((s) => aspectMatches(s, frame));
}

/** Window rect (screen DIPs) → captured-frame pixels for one screen, clamped; null if off-frame. */
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

/**
 * A window reported at exactly (0,0). Wayland (GNOME/KDE on Ubuntu 22.04+)
 * hides window positions from apps, so Chrome reports 0,0 for every window
 * there; a mask drawn from that lands in the corner while the real window
 * stays visible. A real PiP is never placed at the very corner, so (0,0) is
 * treated as "position unknown" and the caller fails closed.
 */
export function untrustedOrigin(win: Pick<Rect, 'x' | 'y'>): boolean {
  return win.x === 0 && win.y === 0;
}

/** Desktop Linux (not Android / ChromeOS), where Wayland may hide window positions. */
export function isDesktopLinuxUA(ua: string): boolean {
  return /Linux/i.test(ua) && !/Android|CrOS/i.test(ua);
}

/**
 * Can window positions be trusted for masking at all? Checked once before the
 * floating controls are kept over a whole-screen share. False → close them.
 */
export function windowPositionsTrusted(opts: {
  pip: Pick<Rect, 'x' | 'y'>;
  opener: Pick<Rect, 'x' | 'y'>;
  ua: string;
}): boolean {
  if (untrustedOrigin(opts.pip)) return false;
  // Wayland reports 0,0 for the classroom window too.
  if (isDesktopLinuxUA(opts.ua) && untrustedOrigin(opts.opener)) return false;
  return true;
}

/**
 * What a capture track shows. `displaySurface` when the browser reports it;
 * otherwise Chrome's track label ("window:…", "web-contents-media-stream://…"
 * for a tab, "screen:…" for a monitor); anything else counts as a monitor so
 * the floating controls fail closed.
 */
export function surfaceFromTrack(displaySurface: string | undefined | null, label: string | undefined | null): string {
  if (displaySurface) return displaySurface;
  const l = (label || '').toLowerCase();
  if (l.startsWith('window:')) return 'window';
  if (l.startsWith('web-contents-media-stream') || l.startsWith('tab:')) return 'browser';
  return 'monitor';
}

export type MaskPlan =
  /** Paint these frame rects black (possibly none: window not on the captured screen). */
  | { kind: 'rects'; rects: Rect[] }
  /** Geometry unusable: black out the whole frame and stop using the floating window. */
  | { kind: 'unsafe' };

/**
 * Where to black out the window on this frame. Every screen that could be the
 * captured one gets its rect masked (two identical monitors → both spots), so
 * an ambiguous setup over-masks rather than leaks.
 */
export function planMask(win: Partial<Rect> | null, screens: ScreenGeom[], frame: FrameSize, marginDip = MASK_MARGIN_DIP): MaskPlan {
  if (!validWindowRect(win) || untrustedOrigin(win)) return { kind: 'unsafe' };
  const candidates = candidateScreens(screens, frame);
  if (!candidates.length) return { kind: 'unsafe' };
  const rects: Rect[] = [];
  for (const s of candidates) {
    const r = windowRectOnFrame(win, s, frame, marginDip);
    if (r) rects.push(r);
  }
  return { kind: 'rects', rects };
}

export function unionRect(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Rects seen in the last `trailMs`. Masking all of them covers the gap between
 * where we last read the window and where the capture actually drew it.
 */
export class RectTrail {
  private items: Array<{ t: number; rects: Rect[] }> = [];
  constructor(private trailMs = MASK_TRAIL_MS) {}
  push(t: number, rects: Rect[]): Rect[] {
    this.items.push({ t, rects });
    const cutoff = t - this.trailMs;
    while (this.items.length > 1 && this.items[0]!.t < cutoff) this.items.shift();
    return this.items.flatMap((i) => i.rects);
  }
  clear() {
    this.items = [];
  }
}

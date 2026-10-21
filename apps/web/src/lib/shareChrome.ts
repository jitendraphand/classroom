/**
 * Teacher share / whiteboard chrome layout.
 * Order matches the Windows teacher app (toolbar.tsx, tools.tsx Meeting groups,
 * whiteboard.tsx MeetingBar). Pure: no DOM.
 *
 * Omitted on purpose (no web equivalent, not faked):
 * - `eco` — Windows drops capture frame rate. The web share already uses a
 *   fixed profile; Video mode is the only rate control.
 * - `sound` — tab / system audio is chosen in the browser share picker.
 *   Nothing can start that capture later.
 */

export const SHARE_BAR_BG = '#0b1220';
export const ACTIVE_BLUE = '#1d4ed8';
export const ACTIVE_BLUE_BORDER = '#93c5fd';
export const BADGE_AMBER = '#f59e0b';
/** Dark ink on amber count badges. Windows `.tsh-count` is this role (`#1a1206`). */
export const BADGE_TEXT = '#1c1f26';
export const STOP_RED = '#f87171';
export const ALLOW_GREEN = '#15803d';
export const FOCUS_RED = '#dc2626';
/** White text on the red fullscreen-exit badge only. */
export const FOCUS_BADGE_TEXT = '#ffffff';
/** Whiteboard meeting column. Same width as the left tool column. */
export const MEETING_BAR_PX = 54;

export const OMITTED_SHARE_CONTROLS = ['eco', 'sound'] as const;

/** Windows share toolbar, left to right. `video` is the web video-mode toggle. */
export const SHARE_TOOLBAR_ORDER = [
  'grip',
  'live',
  'mic',
  'cam',
  'videos',
  'video',
  'chat',
  'hands',
  'people',
  'admit',
  'annotate',
  'stop',
] as const;

export type ShareToolbarId = (typeof SHARE_TOOLBAR_ORDER)[number];

export type ShareToolbarFlags = {
  /** Video-mode toggle is wired. */
  video?: boolean;
  /** Student-videos control is wired. Default on. */
  videos?: boolean;
  /** Annotate pen. Default on for a screen share. */
  annotate?: boolean;
};

export function shareToolbarIds(flags: ShareToolbarFlags = {}): ShareToolbarId[] {
  return SHARE_TOOLBAR_ORDER.filter((id) => {
    if (id === 'video') return !!flags.video;
    if (id === 'videos') return flags.videos !== false;
    if (id === 'annotate') return flags.annotate !== false;
    return true;
  });
}

/** Where the vertical rules sit: before chat, and before Stop. */
export function shareToolbarSeparators(ids: readonly ShareToolbarId[]): { before: ShareToolbarId }[] {
  const out: { before: ShareToolbarId }[] = [];
  if (ids.includes('chat')) out.push({ before: 'chat' });
  if (ids.includes('stop')) out.push({ before: 'stop' });
  return out;
}

export function badgeText(n: number): string {
  if (!(n > 0)) return '';
  return n > 9 ? '9+' : String(Math.floor(n));
}

export function admitLabel(waiting: number, oldestName?: string | null): string {
  if (waiting > 1) return `Admit all ${waiting} waiting`;
  if (waiting === 1 && oldestName) return `Admit ${oldestName}`;
  return 'Nobody waiting';
}

/** Amber outline when someone is waiting. */
export function admitTone(waiting: number): 'warn' | 'idle' {
  return waiting > 0 ? 'warn' : 'idle';
}

export const ANNOTATE_GROUP_ORDER = ['draw', 'erase', 'color', 'perm'] as const;

export const ANNOTATE_DRAW_TOOLS = ['pen', 'hl', 'line', 'arrow', 'rect', 'ellipse'] as const;
export type AnnotateDrawTool = (typeof ANNOTATE_DRAW_TOOLS)[number];

/** Same swatches as the Windows annotate tools. */
export const ANNOTATE_COLORS = ['#ef4444', '#22c55e', '#f59e0b', '#3b82f6', '#ffffff'] as const;

export const THICKNESS_MIN = 1;
export const THICKNESS_MAX = 12;

/** Pen thickness 1..12. Highlighter is wider, same rule as the Windows tools. */
export function toolWidth(tool: string, thickness: number): number {
  const t = Math.min(THICKNESS_MAX, Math.max(THICKNESS_MIN, Math.round(Number.isFinite(thickness) ? thickness : 3) || 3));
  if (tool === 'hl' || tool === 'highlight') return t * 6 + 4;
  return t;
}

export type BarOrient = 'horizontal' | 'vertical';

export function flipOrient(o: BarOrient): BarOrient {
  return o === 'horizontal' ? 'vertical' : 'horizontal';
}

export function parseOrient(v: unknown): BarOrient {
  return v === 'vertical' ? 'vertical' : 'horizontal';
}

/** Whiteboard meeting bar, top to bottom. Stop and End sit after the spacer. */
export const MEETING_BAR_ORDER = ['mic', 'cam', 'chat', 'people', 'admit', 'perm', 'muteall', 'videos', 'stop', 'end'] as const;

export type MeetingBarId = (typeof MEETING_BAR_ORDER)[number];

export function meetingBarIds(): MeetingBarId[] {
  return [...MEETING_BAR_ORDER];
}

/** People / hands badge: raised hands plus students who left fullscreen. */
export function peopleBadgeCount(hands: number, focusAlerts: number): number {
  return Math.max(0, hands) + Math.max(0, focusAlerts);
}

export function focusAlertDanger(focusAlerts: number): boolean {
  return focusAlerts > 0;
}

/** Keep a floating panel inside the window that owns it. */
export function clampPanel(
  pos: { x: number; y: number },
  size: { w: number; h: number },
  area: { w: number; h: number }
): { x: number; y: number } {
  const w = Math.max(1, size.w);
  const h = Math.max(1, size.h);
  const aw = Number.isFinite(area.w) ? area.w : 0;
  const ah = Number.isFinite(area.h) ? area.h : 0;
  const maxX = Math.max(0, aw - w);
  const maxY = Math.max(0, ah - h);
  const x = Number.isFinite(pos.x) ? pos.x : 8;
  const y = Number.isFinite(pos.y) ? pos.y : 8;
  return {
    x: Math.round(Math.min(maxX, Math.max(0, x))),
    y: Math.round(Math.min(maxY, Math.max(0, y))),
  };
}

/** Gap between the share bar and the annotate tools panel (Windows openAnnotateTools). */
export const ANNOTATE_TOOLS_GAP = 8;

/** Remembered drag of the annotate tools panel. `{x,y}` in viewport pixels. */
export const ANNOTATE_TOOLS_POS_KEY = 'classroom.annotateTools';

/**
 * Wayland "no window positions" note. Dismissed once per browser.
 * Not the yellow strip under the share pill.
 */
export const SHARE_POSITION_NOTICE_KEY = 'classroom.sharePositionNotice';

export function parseAnnotateToolsPos(raw: string | null): { x: number; y: number } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (typeof v.x === 'number' && typeof v.y === 'number' && Number.isFinite(v.x) && Number.isFinite(v.y)) {
      return { x: v.x, y: v.y };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** True when the whole panel sits inside the viewport (Windows saved-position rule). */
export function annotateToolsPosInside(
  pos: { x: number; y: number },
  panel: { w: number; h: number },
  viewport: { w: number; h: number }
): boolean {
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return false;
  const pw = panel.w;
  const ph = panel.h;
  const vw = viewport.w;
  const vh = viewport.h;
  if (!(pw > 0) || !(ph > 0) || !(vw > 0) || !(vh > 0)) return false;
  return pos.x >= 0 && pos.y >= 0 && pos.x + pw <= vw && pos.y + ph <= vh;
}

function overlapsY(y: number, h: number, top: number, bottom: number): boolean {
  return y < bottom && y + h > top;
}

/**
 * Where the annotate tools panel opens.
 *
 * Same rule as Windows `openAnnotateTools` (main.ts): the panel's right edge
 * lines up with the share bar, 8 px under the bar. If that would leave the
 * viewport, it sits 8 px above the bar instead. X is clamped into the viewport.
 * A saved drag is used only when the whole panel is on screen.
 * The automatic spot stays clear of the class header and the share bar.
 */
export function placeAnnotateTools(opts: {
  panel: { w: number; h: number };
  viewport: { w: number; h: number };
  bar?: { x: number; y: number; w: number; h: number } | null;
  saved?: { x: number; y: number } | null;
  /** Bottom of the class title row. The automatic spot starts at or below this. */
  headerBottom?: number;
}): { x: number; y: number } {
  const pw = Math.max(1, Number.isFinite(opts.panel.w) ? opts.panel.w : 1);
  const ph = Math.max(1, Number.isFinite(opts.panel.h) ? opts.panel.h : 1);
  const vw = Math.max(0, Number.isFinite(opts.viewport.w) ? opts.viewport.w : 0);
  const vh = Math.max(0, Number.isFinite(opts.viewport.h) ? opts.viewport.h : 0);
  const headerRaw = opts.headerBottom;
  const header = Math.max(0, typeof headerRaw === 'number' && Number.isFinite(headerRaw) ? headerRaw : 0);
  const saved = opts.saved;
  if (saved && annotateToolsPosInside(saved, { w: pw, h: ph }, { w: vw, h: vh })) {
    return { x: Math.round(saved.x), y: Math.round(saved.y) };
  }

  const bar = opts.bar && opts.bar.w > 0 && opts.bar.h > 0 ? opts.bar : null;
  const maxX = Math.max(0, vw - pw);
  const clampX = (x: number) => Math.round(Math.min(maxX, Math.max(0, Number.isFinite(x) ? x : 0)));

  let x: number;
  let y: number;
  if (bar) {
    x = bar.x + bar.w - pw;
    y = bar.y + bar.h + ANNOTATE_TOOLS_GAP;
    if (y + ph > vh) y = Math.max(0, bar.y - ph - ANNOTATE_TOOLS_GAP);
  } else {
    x = vw - pw - 16;
    y = 96;
    if (y + ph > vh) y = Math.max(0, vh - ph - ANNOTATE_TOOLS_GAP);
  }
  x = clampX(x);

  const coversHeader = (yy: number) => header > 0 && yy < header;
  const coversBar = (yy: number) => !!bar && overlapsY(yy, ph, bar.y, bar.y + bar.h);
  if (coversHeader(y) || coversBar(y)) {
    const below = bar ? bar.y + bar.h + ANNOTATE_TOOLS_GAP : header;
    const above = bar ? bar.y - ph - ANNOTATE_TOOLS_GAP : header;
    const clear = (yy: number) => yy >= 0 && !coversHeader(yy) && !coversBar(yy);
    if (clear(below)) y = below;
    else if (clear(above)) y = above;
    else if (!coversBar(Math.max(header, below))) y = Math.max(header, below);
    else y = Math.max(header, y);
  }

  return { x, y: Math.round(y) };
}

/**
 * Yellow strip under the in-tab share pill. The Wayland position note is not
 * one of these; it lives on the pill tooltip and a one-time toast.
 */
export function inlineShareDockHint(
  fallback: string,
  hints: { share: string; screens: string; unsafe: string }
): string | undefined {
  if (fallback === 'position') return undefined;
  if (fallback === 'screens') return hints.screens;
  if (fallback === 'unsafe') return hints.unsafe;
  return hints.share;
}

/** True until this browser has dismissed the Wayland position toast. */
export function sharePositionNoticeOpen(seen: string | null): boolean {
  return seen !== '1';
}

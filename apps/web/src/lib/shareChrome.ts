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
export const BADGE_TEXT = '#111111';
export const STOP_RED = '#f87171';
export const ALLOW_GREEN = '#15803d';
export const FOCUS_RED = '#dc2626';
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

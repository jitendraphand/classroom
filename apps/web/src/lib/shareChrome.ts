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
  'stop',
] as const;

export type ShareToolbarId = (typeof SHARE_TOOLBAR_ORDER)[number];

export type ShareToolbarFlags = {
  /** Video-mode toggle is wired. */
  video?: boolean;
  /** Student-videos control is wired. Default on. */
  videos?: boolean;
};

export function shareToolbarIds(flags: ShareToolbarFlags = {}): ShareToolbarId[] {
  return SHARE_TOOLBAR_ORDER.filter((id) => {
    if (id === 'video') return !!flags.video;
    if (id === 'videos') return flags.videos !== false;
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

/** Whiteboard meeting bar, top to bottom. Stop and End sit after the spacer. */
export const MEETING_BAR_ORDER = ['mic', 'cam', 'chat', 'people', 'perm', 'muteall', 'videos', 'stop', 'end'] as const;

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

/**
 * Wayland "no window positions" note. Dismissed once per browser.
 * Not the yellow strip under the share pill.
 */
export const SHARE_POSITION_NOTICE_KEY = 'classroom.sharePositionNotice';

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

/**
 * Entire-screen share with floating controls (blacked out for students): the
 * smallest useful set, so the black patch stays small. "more" opens the full
 * row; any button there acts and folds it back in the same click (Document
 * Picture-in-Picture resizes only during a click, so a timer could not shrink
 * the window again).
 */
export type ShareMiniId = 'live' | 'mic' | 'hands' | 'chat' | 'more' | 'stop';

export function shareToolbarMiniIds(): ShareMiniId[] {
  return ['live', 'mic', 'hands', 'chat', 'more', 'stop'];
}

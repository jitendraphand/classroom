/**
 * Student fullscreen / focus status. A web page cannot force fullscreen, so
 * the student page detects leaving it (cover + teacher alert) instead.
 * Pure, so it is unit-tested (tests/focusStatus.test.ts) and shared by the
 * student client, the /focus route and the teacher UI.
 */

export type FocusStatus =
  /** In fullscreen (or focus mode on a browser without the Fullscreen API) and visible. */
  | 'fullscreen'
  /** Fullscreen supported but not active (pressed Esc, swiped, never tapped in). */
  | 'left'
  /** Tab/app hidden: switched tab, app or locked the phone. */
  | 'away'
  /** No Fullscreen API (iPhone Safari): focus mode instead, never flagged as "left". */
  | 'unsupported';

export const FOCUS_STATUSES: readonly FocusStatus[] = ['fullscreen', 'left', 'away', 'unsupported'];

export function parseFocusStatus(v: unknown): FocusStatus | null {
  return typeof v === 'string' && (FOCUS_STATUSES as readonly string[]).includes(v) ? (v as FocusStatus) : null;
}

export type FocusInputs = {
  /** document.fullscreenEnabled || document.webkitFullscreenEnabled */
  fullscreenSupported: boolean;
  /** document.fullscreenElement || document.webkitFullscreenElement */
  isFullscreen: boolean;
  /** document.visibilityState === 'hidden' */
  hidden: boolean;
};

/** Current status from what the browser reports. Hidden wins: a hidden page is away whatever else. */
export function computeFocusStatus(i: FocusInputs): FocusStatus {
  if (i.hidden) return 'away';
  if (!i.fullscreenSupported) return 'unsupported';
  return i.isFullscreen ? 'fullscreen' : 'left';
}

/** The student page shows the "Tap to return to fullscreen" cover. */
export function needsCover(status: FocusStatus): boolean {
  return status === 'left' || status === 'away';
}

/** iPhone / iPod (not iPad: iPadOS Safari has element fullscreen and uses the normal flow). */
export function isIPhoneUA(ua: string): boolean {
  return /iPhone|iPod/i.test(ua);
}

/**
 * Teacher-facing label, or null when nothing to flag. `unsupported` is an
 * informational note, not an alert: the student cannot do anything about it.
 */
export function focusLabel(status: FocusStatus | null | undefined, iphone = false): string | null {
  if (status === 'left') return 'Left fullscreen';
  if (status === 'away') return 'Switched away';
  if (status === 'unsupported') return iphone ? 'iPhone - fullscreen not supported' : 'Fullscreen not supported';
  return null;
}

export function isFocusAlert(status: FocusStatus | null | undefined): boolean {
  return status === 'left' || status === 'away';
}

export function countFocusAlerts(list: Array<{ focus?: FocusStatus | null }>): number {
  return list.reduce((n, p) => n + (isFocusAlert(p.focus) ? 1 : 0), 0);
}

/** Stored value in the Redis hash (participant id → JSON). */
export type StoredFocus = { s: FocusStatus; ip?: 1; t: number };

export function encodeFocus(status: FocusStatus, iphone: boolean, now: number): string {
  const v: StoredFocus = { s: status, t: now };
  if (iphone) v.ip = 1;
  return JSON.stringify(v);
}

export function decodeFocus(raw: string | null | undefined): { focus: FocusStatus; iphone: boolean } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredFocus>;
    const s = parseFocusStatus(v.s);
    return s ? { focus: s, iphone: v.ip === 1 } : null;
  } catch {
    return null;
  }
}

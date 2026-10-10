/**
 * One device per student at a time (pure; shared with the Windows app via
 * its sync script, so no '@/' imports here).
 *
 * A school-app student arriving at a class they already hold a seat in, from a
 * browser whose student cookie is not that seat's session token, is a second
 * device: the seat's session token is rotated to the new device, the old token
 * is remembered as replaced (its API calls get `replaced: true`), and LiveKit's
 * duplicate-identity rule disconnects the old device as soon as the new one
 * connects. The teacher gets a toast from `takeovers` in the room state.
 */

export type TakeoverPolicy = 'takeover' | 'approval';
/** Default; 'approval' is reserved (not implemented: the newer device always wins). */
export const DEFAULT_TAKEOVER_POLICY: TakeoverPolicy = 'takeover';

/** How long a replaced token keeps answering `replaced` (student cookie lifetime). */
export const REPLACED_TOKEN_TTL_S = 60 * 60 * 12;
/** Teacher toasts are shown for takeovers newer than this. */
export const TAKEOVER_TOAST_WINDOW_MS = 2 * 60 * 1000;
export const TAKEOVER_LIST_MAX = 10;

export function isSecondDevice(opts: { cookieToken: string | null | undefined; seatToken: string; seatStatus: string }): boolean {
  if (opts.seatStatus === 'LEFT') return false;
  return !!opts.seatToken && opts.cookieToken !== opts.seatToken;
}

export type TakeoverNotice = { participantId: string; displayName: string; at: number };

export function parseTakeovers(raw: readonly string[], now: number, windowMs = TAKEOVER_TOAST_WINDOW_MS): TakeoverNotice[] {
  const out: TakeoverNotice[] = [];
  for (const r of raw) {
    try {
      const v = JSON.parse(r) as Partial<TakeoverNotice>;
      if (typeof v.participantId === 'string' && typeof v.displayName === 'string' && typeof v.at === 'number' && now - v.at <= windowMs) {
        out.push({ participantId: v.participantId, displayName: v.displayName, at: v.at });
      }
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Notices the teacher has not been shown yet (strictly newer than `seenAt`). */
export function freshTakeovers(list: readonly TakeoverNotice[] | undefined, seenAt: number): TakeoverNotice[] {
  return (list ?? []).filter((t) => t.at > seenAt);
}

export function takeoverToastText(t: TakeoverNotice): string {
  return `${t.displayName} joined from another device. The older device was disconnected.`;
}

/**
 * Poll intervals for classroom clients.
 *
 * The server sends a tiny LiveKit data packet (STATE_TOPIC) after any change a
 * client must see quickly (mute, sample rotation, admit, stage, end…), so the
 * HTTP polls are only a safety net while the LiveKit connection is up. Without
 * a live connection (connecting, reconnecting) the old fast polls apply.
 */
export const STATE_TOPIC = 'cls-state';

export type PollRole = 'teacher' | 'student' | null;

export function statePollMs(opts: { role: PollRole; hidden: boolean; pushLive: boolean }): number {
  const { role, hidden, pushLive } = opts;
  if (role === 'teacher') {
    // A sharing teacher's tab is usually hidden behind the shared window, and the
    // share HUD still needs hands / waiting counts: never slow down on hidden.
    return pushLive ? 5000 : 2000;
  }
  if (pushLive) return hidden ? 15000 : 6000;
  return hidden ? 10000 : 2000;
}

export function chatPollMs(opts: { hidden: boolean; pushLive: boolean }): number {
  // Messages arrive as server data packets; the poll only repairs gaps.
  if (opts.pushLive) return opts.hidden ? 30000 : 15000;
  return opts.hidden ? 10000 : 3000;
}

/** Waiting-room poll (student not yet in LiveKit): back off while hidden. */
export function waitingPollMs(hidden: boolean): number {
  return hidden ? 6000 : 2000;
}

/** Requests per minute for a fixed interval (for docs / tests). */
export function perMinute(ms: number): number {
  return Math.round((60000 / ms) * 10) / 10;
}

export type NudgeAudience = 'all' | 'teacher';

/** Merge pending nudges for one room: any 'all' wins. */
export function mergeAudience(a: NudgeAudience | undefined, b: NudgeAudience): NudgeAudience {
  return a === 'all' || b === 'all' ? 'all' : 'teacher';
}

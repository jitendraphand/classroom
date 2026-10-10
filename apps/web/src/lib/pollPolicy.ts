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
    // Every change the teacher sees is pushed (STATE_TOPIC nudges, chat
    // packets): the poll is only a 30 s safety net while connected.
    return pushLive ? 30000 : 2000;
  }
  if (pushLive) return hidden ? 60000 : 30000;
  return hidden ? 10000 : 2000;
}

export function chatPollMs(opts: { hidden: boolean; pushLive: boolean }): number {
  // Messages arrive as server data packets; the poll only repairs gaps.
  if (opts.pushLive) return 60000;
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

/**
 * Who refetches after a change: everyone, the teacher only, or the teacher plus
 * these participants (participant ids), e.g. a lowered hand or a draw request.
 * Targeted nudges spare every other student a /state request.
 */
export type NudgeAudience = 'all' | 'teacher' | { participantIds: string[] };

/** Merge pending nudges for one room: any 'all' wins; targeted lists union. */
export function mergeAudience(a: NudgeAudience | undefined, b: NudgeAudience): NudgeAudience {
  if (a === 'all' || b === 'all') return 'all';
  const ids = new Set<string>();
  for (const x of [a, b]) if (x && typeof x === 'object') x.participantIds.forEach((id) => ids.add(id));
  return ids.size ? { participantIds: [...ids] } : 'teacher';
}

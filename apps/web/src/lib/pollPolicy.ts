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
    // Every change the teacher sees is pushed (STATE_TOPIC / SIGNAL_TOPIC,
    // chat packets): the poll is only a 60 s safety net while connected.
    return pushLive ? 60000 : 2000;
  }
  if (pushLive) return hidden ? 120000 : 60000;
  // Connecting / reconnecting: during a join wave of 1,500 students a 2 s poll
  // was most of the /state load. 5 s (jittered) is enough to see admit/end.
  return hidden ? 15000 : STUDENT_UNLIVE_POLL_MS;
}

/** Student /state poll while LiveKit is not connected yet. */
export const STUDENT_UNLIVE_POLL_MS = 5000;

export function chatPollMs(opts: { hidden: boolean; pushLive: boolean }): number {
  // Messages arrive as server data packets; the poll only repairs gaps.
  if (opts.pushLive) return 60000;
  return opts.hidden ? 10000 : 3000;
}

/** Waiting-room poll (student not yet in LiveKit): back off while hidden. */
export function waitingPollMs(hidden: boolean): number {
  return hidden ? 8000 : 3000;
}

/**
 * Spread a period by ±frac so thousands of clients that started together do
 * not stay in lock-step. `rnd` in [0,1).
 */
export function jitterMs(ms: number, frac = 0.2, rnd: number = Math.random()): number {
  return Math.max(0, Math.round(ms * (1 - frac + 2 * frac * rnd)));
}

/** Default student refetch spread after a class-wide "state changed" push. */
export const NUDGE_SPREAD_MS = 3000;

/** Spread the server puts in a nudge: class-wide nudges spread, targeted ones do not. */
export function nudgeSpreadMs(audience: NudgeAudience, env: Record<string, string | undefined> = process.env): number {
  if (audience !== 'all') return 0;
  const n = Number.parseInt(env.STATE_PUSH_SPREAD_MS ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 10_000) : NUDGE_SPREAD_MS;
}

/** How long a client waits before refetching after a nudge (teacher: now). */
export function nudgeDelayMs(packet: unknown, role: PollRole, rnd: number = Math.random()): number {
  if (role === 'teacher') return 0;
  const spread = (packet as { spread?: unknown } | null)?.spread;
  const s = typeof spread === 'number' && Number.isFinite(spread) ? Math.min(Math.max(spread, 0), 10_000) : 0;
  return Math.floor(s * rnd);
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

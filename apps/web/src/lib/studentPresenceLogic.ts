/**
 * Student presence from LiveKit (pure rules, unit-tested in
 * tests/studentPresence.test.ts).
 *
 * A student who closes the tab never calls /leave, so their seat stayed
 * ADMITTED and they lingered on the teacher's roster for minutes. LiveKit
 * tells us at once (participant_left: the client sends a leave on pagehide)
 * or within its departure timeout (participant_connection_aborted, ~15-20 s
 * when the tab/machine just dies). The webhook records the time the student's
 * connection went away; the teacher's roster hides an admitted student whose
 * connection has been gone for STUDENT_GONE_GRACE_MS (a page refresh or a
 * network blip reconnects within that grace and clears the mark). The seat
 * itself stays ADMITTED, so the student can come back with the same link.
 */
export const STUDENT_GONE_GRACE_MS = 8_000;

export type StudentLive = { sid: string; gone?: number };

export function parseLive(raw: string | null | undefined): StudentLive | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as StudentLive;
    return v && typeof v.sid === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * New record after a webhook event, or `undefined` to leave it unchanged.
 * A `left` for an older connection (the student already reconnected with a
 * new sid, e.g. refresh or another device) is ignored.
 */
export function nextLive(cur: StudentLive | null, ev: { kind: 'joined' | 'left'; sid: string; at: number }): StudentLive | undefined {
  if (ev.kind === 'joined') return { sid: ev.sid };
  if (cur && cur.sid !== ev.sid) return undefined;
  if (cur?.gone) return undefined;
  return { sid: ev.sid, gone: ev.at };
}

/** Has this student's connection been gone long enough to drop off the roster? */
export function isGone(live: StudentLive | null, now: number): boolean {
  return !!live?.gone && now - live.gone >= STUDENT_GONE_GRACE_MS;
}

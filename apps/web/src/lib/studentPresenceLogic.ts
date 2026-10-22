/**
 * Student presence (pure rules, unit-tested in tests/studentPresence.test.ts).
 *
 * A student who closes the tab never calls /leave, so their seat stayed
 * ADMITTED. The student client disconnects on pagehide (and the teacher
 * reports ParticipantDisconnected), so an explicit leave is hidden after
 * STUDENT_GONE_GRACE_MS. A crash, kill, or network drop does not send that
 * leave: LiveKit server v1.13.9 only notices after its hardcoded signal ping
 * (5s interval + 15s timeout), which is why the roster used to wait ~20–24s.
 *
 * The student client heartbeats every HEARTBEAT_INTERVAL_MS (jittered so 2,500
 * clients do not stampede). The roster drops a student only after LiveKit
 * says they left (webhook / ParticipantDisconnected) plus STUDENT_GONE_GRACE_MS.
 * A late heartbeat marks "reconnecting" but does not remove them: under load
 * the beat arrives late while they are still in the room, and dropping them
 * made the teacher count disagree with admin "Students connected".
 * The seat stays ADMITTED, so the same link brings them back.
 */
export const STUDENT_GONE_GRACE_MS = 2_500;

/** How often the student client posts /heartbeat (≥30s; jitter added on the client). */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** Extra delay mixed into each client's period so heartbeats do not align. */
export const HEARTBEAT_JITTER_MS = 5_000;
/**
 * Last beat this old → show "reconnecting", but keep the seat. One missed
 * post (a brief glitch) stays under this.
 */
export const HEARTBEAT_RECONNECTING_MS = 50_000;
/**
 * A beat this old used to drop the roster. It no longer does: a late beat
 * stays "reconnecting" and the seat stays. LiveKit leave is what removes them.
 * The constant remains so the reconnecting window stays below it.
 */
export const HEARTBEAT_STALE_MS = 80_000;

/** Period for one client: 30s plus 0..jitter ms. `rand` in [0, 1]. */
export function heartbeatPeriodMs(rand = Math.random()): number {
  const r = Number.isFinite(rand) ? Math.min(1, Math.max(0, rand)) : 0;
  return HEARTBEAT_INTERVAL_MS + Math.floor(r * HEARTBEAT_JITTER_MS);
}

/** Teacher-side grace after ConnectionQuality.Lost / a reconnecting signal. */
export const LOST_GRACE_MS = 5_000;

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

export type Heartbeat = { at: number };

export function parseBeat(raw: string | null | undefined): Heartbeat | null {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { at: n };
}

/**
 * Hide from the roster only after an explicit LiveKit leave (`live.gone`)
 * has passed STUDENT_GONE_GRACE_MS. A stale or missing heartbeat does not
 * hide anyone — that is a "reconnecting" chip, not a smaller class.
 */
export function rosterHidden(live: StudentLive | null, beat: Heartbeat | null, now: number): boolean {
  void beat;
  if (live?.gone != null) return now - live.gone >= STUDENT_GONE_GRACE_MS;
  return false;
}

export type ConnectionPhase = 'ok' | 'reconnecting' | 'gone';

/** Roster chip: explicit leave inside its grace, or a beat that is late but not stale yet. */
export function connectionPhase(live: StudentLive | null, beat: Heartbeat | null, now: number): ConnectionPhase {
  if (rosterHidden(live, beat, now)) return 'gone';
  if (live?.gone != null) return 'reconnecting';
  if (beat && now - beat.at >= HEARTBEAT_RECONNECTING_MS) return 'reconnecting';
  return 'ok';
}

export type HeartbeatDecision =
  | { ignore: true }
  | { ignore: false; live: StudentLive; beat: Heartbeat; nudge: boolean };

/**
 * Accept a student heartbeat. A different sid is ignored only while the
 * current connection is still `ok`, so an old tab cannot refresh a live one.
 * A reconnect (phase reconnecting or gone) may take the seat and clears `gone`.
 * `nudge` is true only when this beat brings someone back — healthy 30s beats
 * must not wake the teacher's safety poll.
 */
export function applyHeartbeat(
  cur: StudentLive | null,
  prevBeat: Heartbeat | null,
  ev: { at: number; sid: string }
): HeartbeatDecision {
  const phase = connectionPhase(cur, prevBeat, ev.at);
  if (cur && cur.gone == null && cur.sid !== ev.sid && phase === 'ok') return { ignore: true };
  return {
    ignore: false,
    live: { sid: ev.sid },
    beat: { at: ev.at },
    nudge: phase !== 'ok',
  };
}

export type PresencePhase = 'present' | 'reconnecting' | 'gone';
export type PresenceSignal = 'ok' | 'lost' | 'left';

/**
 * Teacher-local presence. `since` is when the current reconnecting period
 * started. `lost` waits LOST_GRACE_MS; `left` waits STUDENT_GONE_GRACE_MS.
 * `ok` always returns to present, including from gone. Once gone, lost/left stay gone.
 */
export function nextPresencePhase(phase: PresencePhase, since: number, signal: PresenceSignal, now: number): PresencePhase {
  if (signal === 'ok') return 'present';
  if (phase === 'gone') return 'gone';
  const grace = signal === 'left' ? STUDENT_GONE_GRACE_MS : LOST_GRACE_MS;
  if (phase === 'reconnecting') return now - since >= grace ? 'gone' : 'reconnecting';
  return 'reconnecting';
}

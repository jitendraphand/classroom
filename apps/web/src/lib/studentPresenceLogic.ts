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
 * The student client heartbeats every HEARTBEAT_INTERVAL_MS. The roster shows
 * "reconnecting" once the last beat is HEARTBEAT_RECONNECTING_MS old and hides
 * them at HEARTBEAT_STALE_MS (about 5–8s after the crash) unless a beat or a
 * new join lands first. The seat stays ADMITTED, so the same link brings them
 * back. The teacher also starts that same short grace when LiveKit reports
 * ConnectionQuality.Lost (the JS SDK's ParticipantConnectionQualityChanged).
 */
export const STUDENT_GONE_GRACE_MS = 2_500;

/** How often the student client posts /heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 2_000;
/**
 * Last beat this old → show "reconnecting", but keep the seat. One missed
 * post (a brief glitch) stays under this.
 */
export const HEARTBEAT_RECONNECTING_MS = 4_000;
/**
 * Last beat this old, and no explicit leave, → drop off the roster.
 * A crash just after a beat is removed at this age; a crash just before the
 * next beat is removed sooner, still inside 5–8s. Two missed posts (~4s) do
 * not reach it.
 */
export const HEARTBEAT_STALE_MS = 7_000;
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
 * Hide from the roster. An explicit leave (`live.gone`) wins after
 * STUDENT_GONE_GRACE_MS even if a heartbeat is still fresh. With no leave, a
 * missing beat is not stale (already-admitted students stay until a client
 * starts beating); a beat older than HEARTBEAT_STALE_MS is.
 */
export function rosterHidden(live: StudentLive | null, beat: Heartbeat | null, now: number): boolean {
  if (live?.gone != null) return now - live.gone >= STUDENT_GONE_GRACE_MS;
  if (beat && now - beat.at >= HEARTBEAT_STALE_MS) return true;
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
 * `nudge` is true only when this beat brings someone back — healthy 2s beats
 * must not wake the teacher's 30s poll.
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

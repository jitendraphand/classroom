/**
 * Where should a signed-in student go right now? Pure decision over the
 * student's audience-filtered occurrences and class-session states, so the
 * routing rules are unit-tested.
 */
import { phaseOf, type Occurrence } from './schedule';

export type SessionState = {
  id: string;
  /** Teacher opened the class and it is running in their room right now. */
  live: boolean;
  startedAt: Date | null;
  endedAt: Date | null;
};

export type AdHocLive = { id: string; subject: string; startedAt: Date | null };

export type RouteDecision =
  | { kind: 'adhoc'; session: AdHocLive }
  | { kind: 'scheduled'; occurrence: Occurrence; session: SessionState | null }
  | { kind: 'upcoming'; occurrence: Occurrence; opensAt: Date }
  | { kind: 'ended'; occurrence: Occurrence; next: Occurrence | null }
  | { kind: 'none'; next: Occurrence | null };

/**
 * Priority:
 *  1. a class the teacher is running now (ad-hoc, or a timetabled one, even past its end);
 *  2. a timetabled class whose waiting room is open (start − early … end) and not ended;
 *  3. later today → countdown;
 *  4. a class that ended early today → "ended" (+ next);
 *  5. nothing → next scheduled class (if any).
 * `occurrences` must already be filtered to the student's grade-division and
 * sorted by start; they may span several days (for "next").
 */
export function decideRoute(input: {
  occurrences: Occurrence[];
  sessions: Map<string, SessionState>;
  liveAdHoc: AdHocLive[];
  now: Date;
  earlyMinutes: number;
  today: string;
}): RouteDecision {
  const { occurrences, sessions, liveAdHoc, now, earlyMinutes, today } = input;

  const liveScheduled = occurrences.find((o) => sessions.get(o.key)?.live);
  if (liveScheduled) return { kind: 'scheduled', occurrence: liveScheduled, session: sessions.get(liveScheduled.key)! };
  if (liveAdHoc.length) return { kind: 'adhoc', session: liveAdHoc[0]! };

  let endedToday: Occurrence | null = null;
  for (const o of occurrences) {
    if (o.date !== today) continue;
    if (phaseOf(o, now, earlyMinutes) !== 'open') continue;
    const s = sessions.get(o.key) ?? null;
    if (s?.endedAt) {
      endedToday ??= o;
      continue;
    }
    return { kind: 'scheduled', occurrence: o, session: s };
  }

  const next = occurrences.find((o) => phaseOf(o, now, earlyMinutes) === 'upcoming') ?? null;
  if (next && next.date === today) {
    return { kind: 'upcoming', occurrence: next, opensAt: new Date(next.start.getTime() - earlyMinutes * 60_000) };
  }
  if (endedToday) return { kind: 'ended', occurrence: endedToday, next };
  return { kind: 'none', next };
}

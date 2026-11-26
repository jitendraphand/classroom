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

export type AdHocLive = {
  id: string;
  subject: string;
  startedAt: Date | null;
  /** Audience of the ad-hoc class (omitted = treated as a whole-grade class). */
  divisions?: string[];
  allDivisions?: boolean;
};

/**
 * How specific a live class's audience is for the student it already matched:
 * a class for the student's own division(s) beats a whole-grade
 * ("all divisions") class, and a single-division class beats a combined one.
 * Higher is more specific.
 */
export function audienceSpecificity(a: { divisions?: string[]; allDivisions?: boolean }): number {
  if (a.allDivisions || !a.divisions?.length) return 0;
  return 1000 - Math.min(a.divisions.length, 999);
}

export type RouteDecision =
  | { kind: 'adhoc'; session: AdHocLive }
  | { kind: 'scheduled'; occurrence: Occurrence; session: SessionState | null }
  | { kind: 'upcoming'; occurrence: Occurrence; opensAt: Date }
  | { kind: 'ended'; occurrence: Occurrence; next: Occurrence | null }
  | { kind: 'none'; next: Occurrence | null };

/**
 * Priority:
 *  1. a class the teacher is running now (ad-hoc, or a timetabled one, even past its end).
 *     When several are live, the most specific audience wins: the student's own
 *     division (ad-hoc or timetabled) before an all-divisions class. Ties keep
 *     timetabled before ad-hoc, then the earlier one;
 *  2. a timetabled class that students can join (start − early … end) and not ended;
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

  // Every live candidate in its old priority order (timetabled first, then
  // ad-hoc by start); a stable pick of the most specific keeps that order on ties.
  type Live = { rank: number; decision: RouteDecision };
  const live: Live[] = [];
  for (const o of occurrences) {
    const s = sessions.get(o.key);
    if (s?.live) live.push({ rank: audienceSpecificity(o), decision: { kind: 'scheduled', occurrence: o, session: s } });
  }
  for (const a of liveAdHoc) live.push({ rank: audienceSpecificity(a), decision: { kind: 'adhoc', session: a } });
  if (live.length) {
    let best = live[0]!;
    for (const c of live) if (c.rank > best.rank) best = c;
    return best.decision;
  }

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

/**
 * Compact fingerprint of a decision: changes exactly when the /student page
 * would show something different (another class, the class going live,
 * ending, a new "next" class). Contains no class details.
 */
export function routeSignature(d: RouteDecision): string {
  switch (d.kind) {
    case 'adhoc':
      return `adhoc:${d.session.id}:1`;
    case 'scheduled':
      return `scheduled:${d.occurrence.key}:${d.session?.live ? 1 : 0}`;
    case 'upcoming':
      return `upcoming:${d.occurrence.key}`;
    case 'ended':
      return `ended:${d.occurrence.key}:${d.next?.key ?? ''}`;
    default:
      return `none:${d.next?.key ?? ''}`;
  }
}

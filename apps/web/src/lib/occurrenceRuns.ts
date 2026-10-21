/**
 * Timetabled ClassSession keys: the first run uses the occurrence key
 * (`slot:<id>:<date>` / `extra:<id>`); later runs after End class append `#2`,
 * `#3`, … so each run has its own startedAt/endedAt and feedback.
 *
 * Reports, the teacher calendar and attendance still group by the base key.
 */
export function occurrenceBaseKey(key: string): string {
  return key.replace(/#\d+$/, '');
}

export function occurrenceRunNumber(key: string): number {
  const m = /#(\d+)$/.exec(key);
  return m ? Number(m[1]) : 1;
}

export function occurrenceKeyForRun(base: string, run: number): string {
  const b = occurrenceBaseKey(base);
  return run <= 1 ? b : `${b}#${run}`;
}

/** Next unused run key for this occurrence (1 → canonical, then #2, #3, …). */
export function nextOccurrenceRunKey(base: string, existingKeys: Iterable<string | null | undefined>): string {
  const b = occurrenceBaseKey(base);
  let max = 0;
  for (const k of existingKeys) {
    if (!k || occurrenceBaseKey(k) !== b) continue;
    max = Math.max(max, occurrenceRunNumber(k));
  }
  return occurrenceKeyForRun(b, max + 1);
}

export function matchesOccurrenceKey(sessionKey: string | null | undefined, occurrenceKey: string): boolean {
  return !!sessionKey && occurrenceBaseKey(sessionKey) === occurrenceBaseKey(occurrenceKey);
}

type SessionBits = {
  occurrenceKey?: string | null;
  startedAt?: Date | null;
  endedAt?: Date | null;
};

/**
 * The session that represents this occurrence right now: a live run, else an
 * open (not-yet-ended) row, else the latest ended run.
 */
export function pickSessionForOccurrence<T extends SessionBits>(sessions: T[], occurrenceKey: string): T | null {
  const matches = sessions.filter((s) => matchesOccurrenceKey(s.occurrenceKey, occurrenceKey));
  if (!matches.length) return null;
  const live = matches.find((s) => s.startedAt && !s.endedAt);
  if (live) return live;
  const open = matches.find((s) => !s.endedAt);
  if (open) return open;
  return [...matches].sort((a, b) => occurrenceRunNumber(b.occurrenceKey!) - occurrenceRunNumber(a.occurrenceKey!))[0] ?? null;
}

/** Prisma `where` that matches the canonical key and every `#n` rerun. */
export function prismaOccurrenceKeys(keys: string[]) {
  const unique = [...new Set(keys.map(occurrenceBaseKey).filter(Boolean))];
  if (!unique.length) return { occurrenceKey: { in: [] as string[] } };
  return {
    OR: unique.flatMap((k) => [{ occurrenceKey: k }, { occurrenceKey: { startsWith: `${k}#` } }]),
  };
}

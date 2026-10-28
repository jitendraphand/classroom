/**
 * Pure rules for one-off timetable changes (ScheduleOverride), shared by the
 * admin UI and the server so both refuse the same things.
 */

export type ChangeKind = 'CANCEL' | 'MODIFY' | 'EXTRA';

/**
 * A substitute must be someone else. Picking the class's own teacher as the
 * "substitute" (X → X) is refused; a time/subject-only change keeps the
 * teacher by leaving the substitute empty.
 */
export function substituteProblem(
  kind: ChangeKind,
  substituteId: string | null | undefined,
  originalTeacherId: string | null | undefined,
  originalName?: string
): string | null {
  if (kind !== 'MODIFY' || !substituteId || !originalTeacherId) return null;
  if (substituteId !== originalTeacherId) return null;
  return `The substitute must be a different teacher from ${originalName || 'the class teacher'}. To change only the time or subject, leave the substitute as "Same teacher".`;
}

/** Label for a MODIFY change: a real substitution, or just a time/subject change. */
export function modifyLabel(o: {
  teacherId?: string | null;
  originalTeacherId?: string | null;
  startMinute?: number | null;
  endMinute?: number | null;
  start?: string | null;
  end?: string | null;
}): 'Substitute' | 'Time change' | 'Changed' {
  const sub = !!o.teacherId && o.teacherId !== o.originalTeacherId;
  if (sub) return 'Substitute';
  const timed = o.startMinute != null || o.endMinute != null || !!o.start || !!o.end;
  return timed ? 'Time change' : 'Changed';
}

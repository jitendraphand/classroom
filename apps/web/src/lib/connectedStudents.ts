/**
 * Who counts as a student in a live class.
 *
 * One rule for the teacher roster, admin "Students connected", and attendance:
 * distinct students actually in the room. Teachers, hidden observers, and a
 * second device of the same student do not add another.
 */

export type CountedParticipant = {
  identity: string;
  metadata?: string | null;
  role?: string | null;
  /** School student id (or another stable per-student key). Devices share it. */
  studentId?: string | null;
};

const OBSERVER_PREFIX = /^(adminpreview_|adminobserver_)/;

export function parseMemberMeta(metadata?: string | null): { role?: string; studentId?: string } {
  if (!metadata) return {};
  try {
    const m = JSON.parse(metadata) as { role?: unknown; studentId?: unknown };
    return {
      role: typeof m.role === 'string' ? m.role : undefined,
      studentId: typeof m.studentId === 'string' && m.studentId ? m.studentId : undefined,
    };
  } catch {
    return {};
  }
}

/** Stable key for one student, or null when this participant is not a student. */
export function connectedStudentKey(p: CountedParticipant): string | null {
  const identity = p.identity || '';
  if (!identity || OBSERVER_PREFIX.test(identity) || identity.startsWith('teacher_')) return null;
  const meta = parseMemberMeta(p.metadata);
  const role = (p.role || meta.role || '').toUpperCase();
  if (role === 'TEACHER' || role === 'ADMIN' || role === 'OBSERVER') return null;
  const isStudent = identity.startsWith('student_') || role === 'STUDENT';
  if (!isStudent) return null;
  const studentId = (p.studentId || meta.studentId || '').trim();
  return studentId ? `stu:${studentId}` : `id:${identity}`;
}

/** First row kept for each student. Order is preserved. */
export function distinctConnectedStudents<T extends CountedParticipant>(list: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const p of list) {
    const key = connectedStudentKey(p);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export function connectedStudentCount(list: readonly CountedParticipant[]): number {
  return distinctConnectedStudents(list).length;
}

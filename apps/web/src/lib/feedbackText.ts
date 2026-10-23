/**
 * End-of-class feedback. Stars are required. The comment is optional, at most
 * 100 characters, and may contain only letters (any Unicode letter, plus the
 * combining marks those letters need, such as Hindi vowel signs), digits,
 * spaces and . , ! ? ' " - ( ) : ;
 * The same rules run in the browser and on the server.
 */

const FEEDBACK_TEXT = /^[\p{L}\p{M}\p{Nd} .,!?'"():;\-]*$/u;

export const FEEDBACK_MAX_COMMENT = 100;

export function feedbackProblem(stars: unknown, comment: unknown): string | null {
  if (typeof stars !== 'number' || !Number.isInteger(stars) || stars < 1 || stars > 5) {
    return 'Choose a rating from 1 to 5 stars.';
  }
  if (comment == null || comment === '') return null;
  if (typeof comment !== 'string') return 'Comment must be text.';
  if (comment.length > FEEDBACK_MAX_COMMENT) return `Comment must be at most ${FEEDBACK_MAX_COMMENT} characters.`;
  if (!FEEDBACK_TEXT.test(comment)) {
    return 'Comment can use only letters, numbers, spaces and . , ! ? \' " - ( ) : ;';
  }
  return null;
}

/** Blank comments are stored as null. Call only after feedbackProblem returns null. */
export function normalizeFeedbackComment(comment: unknown): string | null {
  if (typeof comment !== 'string') return null;
  const t = comment.trim();
  return t.length ? t : null;
}

/**
 * A rating counts toward averages and ranks only when that student was
 * present (admitted into the class). Written comments are never part of a
 * teacher-facing value.
 */
export function presentStars(
  ratings: { studentId: string; stars: number; comment?: string | null }[],
  presentStudentIds: ReadonlySet<string>
): number[] {
  return ratings.filter((r) => presentStudentIds.has(r.studentId)).map((r) => r.stars);
}

export function averageStars(stars: number[]): number | null {
  if (!stars.length) return null;
  const sum = stars.reduce((a, b) => a + b, 0);
  return Math.round((sum / stars.length) * 10) / 10;
}

/** Grace for "still in class at the end": a drop in the last moments still counts. */
export const FEEDBACK_END_GRACE_MS = 90_000;

/**
 * Item 7: the end-of-class form is only for students who were in the class
 * when the teacher ended it. A student who left mid-class (and did not come
 * back) has leftAt well before the end; one who rejoined is closed at the end.
 */
export function presentAtEnd(
  rec: { openSids: string[]; connectedSince: Date | null; leftAt: Date | null },
  endedAt: Date | null
): boolean {
  if (rec.openSids.length || rec.connectedSince) return true; // still connected (end not processed yet)
  if (!endedAt || !rec.leftAt) return false;
  return rec.leftAt.getTime() >= endedAt.getTime() - FEEDBACK_END_GRACE_MS;
}

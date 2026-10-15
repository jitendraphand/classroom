/**
 * Ad-hoc class form validation (teacher dashboard). Returns the message to
 * show next to Start, or null when the form can be submitted.
 */
export function adhocProblem(f: { campus: string; grade: string; all: boolean; divisions: readonly string[] }): string | null {
  if (!f.campus) return 'Choose a campus.';
  if (!f.grade) return 'Choose a grade.';
  if (!f.all && !f.divisions.length) return 'Tick at least one division (or "All divisions") to start the class.';
  return null;
}

/**
 * Ad-hoc ("extra") class form on the teacher dashboard. Pure, unit-tested.
 *
 * Nov 25: a teacher picks ONE grade and any combination of the campuses the
 * admin assigned for that grade, and any combination of its divisions
 * (foundations). The server checks the same rule (canTeachAudience over every
 * campus): each chosen division must be assigned in each chosen campus.
 */
export type AdhocGradeChoice = {
  campus: string;
  grade: string;
  label: string;
  whole: boolean;
  divisions: { name: string; label: string }[];
  campusLabel?: string;
  gradeLabel?: string;
};

/** Message to show next to Start, or null when the form can be submitted. */
export function adhocProblem(f: { campus?: string; campuses?: readonly string[]; grade: string; all: boolean; divisions: readonly string[] }): string | null {
  const campuses = f.campuses ?? (f.campus ? [f.campus] : []);
  if (!campuses.length) return 'Choose at least one campus.';
  if (!f.grade) return 'Choose a grade.';
  if (!f.all && !f.divisions.length) return 'Tick at least one division (or "All divisions") to start the class.';
  return null;
}

const gradeNum = (g: string) => (/^\d+$/.test(g) ? Number(g) : Number.POSITIVE_INFINITY);

/** Grades the teacher may start (any campus), numeric order: Grade 6, Grade 7… */
export function adhocGrades(choices: readonly AdhocGradeChoice[]): { grade: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const c of choices) if (!seen.has(c.grade)) seen.set(c.grade, c.gradeLabel || c.label || c.grade);
  return [...seen.entries()]
    .map(([grade, label]) => ({ grade, label }))
    .sort((a, b) => gradeNum(a.grade) - gradeNum(b.grade) || a.grade.localeCompare(b.grade));
}

/** Campuses where the teacher teaches this grade. */
export function adhocCampuses(choices: readonly AdhocGradeChoice[], grade: string): { campus: string; label: string }[] {
  return choices.filter((c) => c.grade === grade).map((c) => ({ campus: c.campus, label: c.campusLabel || c.campus }));
}

/**
 * Divisions the teacher may pick for these campuses: those offered in EVERY
 * chosen campus; "All divisions" only when the whole grade is assigned in each.
 */
export function adhocDivisions(
  choices: readonly AdhocGradeChoice[],
  grade: string,
  campuses: readonly string[]
): { divisions: { name: string; label: string }[]; whole: boolean } {
  const rows = choices.filter((c) => c.grade === grade && campuses.includes(c.campus));
  if (!rows.length || rows.length < campuses.length) return { divisions: [], whole: false };
  const [first, ...rest] = rows;
  const divisions = first!.divisions.filter((d) => rest.every((r) => r.divisions.some((x) => x.name === d.name)));
  return { divisions, whole: rows.every((r) => r.whole) };
}

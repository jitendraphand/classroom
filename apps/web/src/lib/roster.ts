import { prisma } from './db';
import { parseCsv } from './csv';
import { ALL_DIVISIONS, normalizeCampus, normalizeDivision, normalizeGrade } from './grades';
import { campusProblem, type MasterCampus } from './campusLogic';
import { rosterAudienceProblem, type MasterGrade } from './gradeMasterLogic';

export type RosterRow = { externalId: string; name: string; campus: string; grade: string; division: string; rollNumber: string | null };

const HEADER_ALIASES: Record<keyof RosterRow, string[]> = {
  externalId: ['externalid', 'studentid', 'student_id', 'id', 'sub'],
  name: ['name', 'studentname', 'student_name', 'fullname'],
  grade: ['grade', 'class', 'std', 'standard'],
  division: ['division', 'div', 'section'],
  rollNumber: ['roll', 'rollno', 'roll_no', 'rollnumber', 'roll_number'],
  campus: ['campus', 'branch'],
};

/**
 * Parse an admin roster CSV: externalId,name,grade,division,roll,campus (header row
 * optional, column names flexible). Returns valid rows + per-line errors.
 * With `master` (Grades & divisions), grade/division must be active entries of
 * it; an empty master list (not set up yet) accepts any grade/division.
 */
export function parseRoster(
  text: string,
  master: MasterGrade[] = [],
  campuses: MasterCampus[] = [],
  /** Campus for rows without one (the school's only campus, or the admin's pick). */
  defaultCampus = ''
): { rows: RosterRow[]; errors: string[] } {
  const table = parseCsv(text);
  const errors: string[] = [];
  if (!table.length) return { rows: [], errors: ['The file is empty'] };
  const head = table[0]!.map((h) => h.trim().toLowerCase().replace(/[\s-]/g, ''));
  const idx: Record<keyof RosterRow, number> = { externalId: 0, name: 1, grade: 2, division: 3, rollNumber: 4, campus: 5 };
  let start = 0;
  const hasHeader = head.some((h) => Object.values(HEADER_ALIASES).flat().includes(h));
  if (hasHeader) {
    start = 1;
    for (const k of Object.keys(HEADER_ALIASES) as (keyof RosterRow)[]) {
      idx[k] = head.findIndex((h) => HEADER_ALIASES[k].includes(h));
    }
    for (const k of ['externalId', 'name', 'grade', 'division'] as const) {
      if (idx[k] < 0) return { rows: [], errors: [`Missing column: ${k}`] };
    }
  }
  const rows: RosterRow[] = [];
  const seen = new Set<string>();
  for (let i = start; i < table.length; i++) {
    const line = i + 1;
    const r = table[i]!;
    const get = (k: keyof RosterRow) => (idx[k] >= 0 ? (r[idx[k]] ?? '').trim() : '');
    const externalId = get('externalId');
    const name = get('name').replace(/\s+/g, ' ');
    const grade = normalizeGrade(get('grade'));
    const division = normalizeDivision(get('division'));
    const campus = normalizeCampus(get('campus')) || normalizeCampus(defaultCampus);
    if (!externalId || !/^[A-Za-z0-9._:@/-]{1,64}$/.test(externalId)) {
      errors.push(`Line ${line}: invalid student ID`);
      continue;
    }
    if (!name || name.length > 100) {
      errors.push(`Line ${line}: missing name`);
      continue;
    }
    if (!grade || !division || division === ALL_DIVISIONS) {
      errors.push(`Line ${line}: missing grade or division`);
      continue;
    }
    if (!campus) {
      errors.push(`Line ${line}: missing campus (add a campus column or pick the campus for the file)`);
      continue;
    }
    const badCampus = campusProblem(campuses, campus);
    if (badCampus) {
      errors.push(`Line ${line}: ${badCampus}`);
      continue;
    }
    const unknown = rosterAudienceProblem(master, grade, division);
    if (unknown) {
      errors.push(`Line ${line}: ${unknown} (add it in Grades & divisions first)`);
      continue;
    }
    if (seen.has(externalId)) {
      errors.push(`Line ${line}: duplicate student ID ${externalId}`);
      continue;
    }
    seen.add(externalId);
    rows.push({ externalId, name, campus, grade, division, rollNumber: get('rollNumber').slice(0, 20) || null });
  }
  return { rows, errors };
}

/** Upsert by externalId. Existing students keep their history; details are refreshed. */
export async function importRoster(rows: RosterRow[]) {
  let created = 0;
  let updated = 0;
  const existing = new Set(
    (await prisma.student.findMany({ where: { externalId: { in: rows.map((r) => r.externalId) } }, select: { externalId: true } })).map(
      (s) => s.externalId
    )
  );
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    await prisma.$transaction(
      chunk.map((r) =>
        prisma.student.upsert({
          where: { externalId: r.externalId },
          create: { ...r, source: 'import' },
          update: { name: r.name, campus: r.campus, grade: r.grade, division: r.division, rollNumber: r.rollNumber, deletedAt: null },
        })
      )
    );
    for (const r of chunk) existing.has(r.externalId) ? updated++ : created++;
  }
  return { created, updated };
}

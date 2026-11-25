/**
 * Student-facing labels for campus, grade and foundation/division.
 * Stored values stay the canonical codes (AIRPORTCAMPUS, 6, SPORTSFOUNDATION);
 * this module only formats them for display. Pure, unit-tested.
 */
import {
  ALL_DIVISIONS,
  normalizeCampus,
  normalizeDivision,
  normalizeGrade,
} from './grades';

export type AudienceLabelCampus = { name: string; label: string };
export type AudienceLabelDivision = { name: string; label: string };
export type AudienceLabelGrade = { name: string; label: string; divisions?: AudienceLabelDivision[] };
export type AudienceLabels = {
  campuses?: AudienceLabelCampus[];
  grades?: AudienceLabelGrade[];
};

/** Known words used to insert spaces in compact codes such as AIRPORTCAMPUS. */
const KNOWN_WORDS = [
  'FOUNDATION',
  'CAMPUS',
  'OSMANPURA',
  'AIRPORT',
  'SCIENCE',
  'SPORTS',
  'CIVIL',
  'FINE',
  'ARTS',
  'CITY',
  'NORTH',
  'SOUTH',
  'EAST',
  'WEST',
].sort((a, b) => b.length - a.length);

function titleWord(w: string): string {
  if (!w) return '';
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}

/**
 * "AIRPORTCAMPUS" → "Airport Campus", "SPORTSFOUNDATION" → "Sports Foundation",
 * "FINEARTSFOUNDATION" → "Fine Arts Foundation". Short codes ("CC", "A") stay
 * as stored. Codes that already contain spaces are trimmed only.
 */
export function prettifyCode(raw: string): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/\s/.test(s)) return s.replace(/\s+/g, ' ');
  if (/^[A-Z0-9]{1,3}$/.test(s)) return s;
  const compact = s.replace(/[^A-Za-z0-9]+/g, '');
  if (!compact) return s;
  const upper = compact.toUpperCase();
  const parts: string[] = [];
  let i = 0;
  while (i < upper.length) {
    const rest = upper.slice(i);
    const word = KNOWN_WORDS.find((w) => rest.startsWith(w));
    if (word) {
      parts.push(titleWord(word));
      i += word.length;
      continue;
    }
    let j = i + 1;
    while (j < upper.length && !KNOWN_WORDS.some((w) => upper.startsWith(w, j))) j += 1;
    parts.push(titleWord(upper.slice(i, j)));
    i = j;
  }
  return parts.join(' ') || s;
}

function gradeKey(raw: string): string {
  return normalizeGrade(raw).replace(/^(\d+)\s*(ST|ND|RD|TH)$/, '$1');
}

export function displayCampusLabel(campus: string, labels?: AudienceLabels): string {
  const c = normalizeCampus(campus);
  if (!c) return '';
  const row = labels?.campuses?.find((x) => normalizeCampus(x.name) === c);
  const text = (row?.label || '').trim();
  if (text && /\s/.test(text)) return text;
  if (text && text.toUpperCase() !== c) return text;
  return prettifyCode(text || campus || c);
}

export function displayGradeLabel(grade: string, labels?: AudienceLabels): string {
  const g = normalizeGrade(grade);
  if (!g) return '';
  const row = labels?.grades?.find((x) => normalizeGrade(x.name) === g);
  const text = (row?.label || grade || g).trim();
  const key = gradeKey(text) || gradeKey(g);
  if (/^\d+$/.test(key) && !/^grade\s/i.test(text)) return `Grade ${key}`;
  if (row?.label && !/^\d+$/.test(row.label.trim())) return row.label.trim();
  return prettifyCode(text);
}

export function displayFoundationLabel(grade: string, division: string, labels?: AudienceLabels): string {
  const d = normalizeDivision(division);
  if (!d || d === ALL_DIVISIONS) return '';
  const g = normalizeGrade(grade);
  const grow = labels?.grades?.find((x) => normalizeGrade(x.name) === g);
  const row = grow?.divisions?.find((x) => normalizeDivision(x.name) === d);
  const text = (row?.label || '').trim();
  if (text && (/\s/.test(text) || text.toUpperCase() !== d)) return text;
  return prettifyCode(text || division || d);
}

/**
 * "Airport Campus · Grade 6 · Sports Foundation".
 * `allDivisions` → "Airport Campus · Grade 6 · all divisions".
 */
export function formatStudentAudience(
  campus: string,
  grade: string,
  divisions: string[],
  allDivisions: boolean,
  labels?: AudienceLabels,
): string {
  const parts = [displayCampusLabel(campus, labels), displayGradeLabel(grade, labels)].filter(Boolean);
  if (allDivisions) {
    parts.push('all divisions');
  } else {
    const foundations = [...divisions]
      .map((d) => displayFoundationLabel(grade, d, labels))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    if (foundations.length) parts.push([...new Set(foundations)].join(', '));
  }
  return parts.join(' · ');
}

export function audienceLabelsFromMaster(
  grades: { name: string; label: string; divisions?: { name: string; label: string }[] }[],
  campuses: { name: string; label: string }[],
): AudienceLabels {
  return {
    campuses: campuses.map((c) => ({ name: c.name, label: c.label || c.name })),
    grades: grades.map((g) => ({
      name: g.name,
      label: g.label || g.name,
      divisions: (g.divisions ?? []).map((d) => ({ name: d.name, label: d.label || d.name })),
    })),
  };
}

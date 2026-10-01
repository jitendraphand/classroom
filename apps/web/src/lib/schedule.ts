/**
 * Timetable maths: weekly recurrence, one-off overrides, time zones, the
 * early waiting-room window and overlap checks. Pure (no Prisma) so every rule
 * is unit-tested; lib/scheduleService.ts feeds it database rows.
 *
 * Conventions
 * - A local date is a 'YYYY-MM-DD' string in the school time zone.
 * - Times are minutes after local midnight (0‥1440).
 * - weekday 0 = Sunday … 6 = Saturday (JS getDay()).
 */
import { audiencesOverlap, audienceIncludes, normalizeDivision, normalizeGrade } from './grades';

export type Audience = { grade: string; divisions: string[]; allDivisions: boolean };

export type SlotLike = Audience & {
  id: string;
  teacherId: string;
  subject: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  effectiveFrom: string | null;
  effectiveTo: string | null;
};

export type OverrideKindT = 'CANCEL' | 'MODIFY' | 'EXTRA';

export type OverrideLike = {
  id: string;
  kind: OverrideKindT;
  date: string;
  slotId: string | null;
  teacherId: string | null;
  grade: string | null;
  divisions: string[];
  allDivisions: boolean;
  subject: string | null;
  startMinute: number | null;
  endMinute: number | null;
  note: string | null;
};

export type Occurrence = Audience & {
  /** Stable id for the ClassSession of this occurrence. */
  key: string;
  date: string;
  slotId: string | null;
  overrideId: string | null;
  teacherId: string;
  /** Timetabled teacher when a substitute takes the class. */
  originalTeacherId: string | null;
  subject: string;
  startMinute: number;
  endMinute: number;
  start: Date;
  end: Date;
  modified: boolean;
  extra: boolean;
  note: string | null;
};

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ------------------------------------------------------------------ dates

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLocalDate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.toISOString().slice(0, 10) === s;
}

/** Prisma @db.Date values arrive as UTC midnight Dates. */
export function dateOnly(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' → Date at UTC midnight (for @db.Date columns). */
export function dateValue(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

export function addDays(date: string, n: number): string {
  const d = dateValue(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  return dateValue(date).getUTCDay();
}

export function daysBetween(from: string, to: string): number {
  return Math.round((dateValue(to).getTime() - dateValue(from).getTime()) / 86_400_000);
}

type Parts = { y: number; m: number; d: number; hh: number; mm: number; ss: number };

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function zonedParts(at: Date, tz: string): Parts {
  const parts = formatter(tz).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day'), hh: get('hour') % 24, mm: get('minute'), ss: get('second') };
}

/** Offset of tz from UTC at instant t, in ms (IST → +19 800 000). */
function offsetMs(t: number, tz: string): number {
  const p = zonedParts(new Date(t), tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** Local date in tz for an instant. */
export function localDateOf(at: Date, tz: string): string {
  const p = zonedParts(at, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Minutes after local midnight in tz for an instant. */
export function localMinuteOf(at: Date, tz: string): number {
  const p = zonedParts(at, tz);
  return p.hh * 60 + p.mm;
}

/** Instant for a local date + minute in tz (DST-safe: re-checks the offset). */
export function zonedTimeToUtc(date: string, minute: number, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, 0, minute);
  const o1 = offsetMs(guess, tz);
  let t = guess - o1;
  const o2 = offsetMs(t, tz);
  if (o2 !== o1) t = guess - o2;
  return new Date(t);
}

export function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) return null;
  return h * 60 + mi;
}

export function formatHHMM(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------ occurrences

function slotActiveOn(slot: SlotLike, date: string): boolean {
  if (slot.weekday !== weekdayOf(date)) return false;
  if (slot.effectiveFrom && date < slot.effectiveFrom) return false;
  if (slot.effectiveTo && date > slot.effectiveTo) return false;
  return true;
}

export function occurrenceKeyForSlot(slotId: string, date: string) {
  return `slot:${slotId}:${date}`;
}
export function occurrenceKeyForExtra(overrideId: string) {
  return `extra:${overrideId}`;
}

/** All classes on one local date after applying that date's overrides. */
export function occurrencesOn(
  date: string,
  slots: SlotLike[],
  overrides: OverrideLike[],
  tz: string
): Occurrence[] {
  const todays = overrides.filter((o) => o.date === date);
  const bySlot = new Map<string, OverrideLike>();
  for (const o of todays) if (o.slotId && o.kind !== 'EXTRA') bySlot.set(o.slotId, o);

  const out: Occurrence[] = [];
  for (const slot of slots) {
    if (!slotActiveOn(slot, date)) continue;
    const ov = bySlot.get(slot.id);
    if (ov?.kind === 'CANCEL') continue;
    const mod = ov?.kind === 'MODIFY' ? ov : null;
    const startMinute = mod?.startMinute ?? slot.startMinute;
    const endMinute = mod?.endMinute ?? slot.endMinute;
    const teacherId = mod?.teacherId ?? slot.teacherId;
    const audience: Audience = mod?.grade
      ? { grade: mod.grade, divisions: mod.divisions, allDivisions: mod.allDivisions }
      : { grade: slot.grade, divisions: slot.divisions, allDivisions: slot.allDivisions };
    out.push({
      ...audience,
      key: occurrenceKeyForSlot(slot.id, date),
      date,
      slotId: slot.id,
      overrideId: mod?.id ?? null,
      teacherId,
      originalTeacherId: teacherId !== slot.teacherId ? slot.teacherId : null,
      subject: mod?.subject || slot.subject,
      startMinute,
      endMinute,
      start: zonedTimeToUtc(date, startMinute, tz),
      end: zonedTimeToUtc(date, endMinute, tz),
      modified: !!mod,
      extra: false,
      note: mod?.note ?? null,
    });
  }
  for (const o of todays) {
    if (o.kind !== 'EXTRA' || !o.teacherId || !o.grade || o.startMinute == null || o.endMinute == null) continue;
    out.push({
      grade: o.grade,
      divisions: o.divisions,
      allDivisions: o.allDivisions,
      key: occurrenceKeyForExtra(o.id),
      date,
      slotId: null,
      overrideId: o.id,
      teacherId: o.teacherId,
      originalTeacherId: null,
      subject: o.subject || 'Extra class',
      startMinute: o.startMinute,
      endMinute: o.endMinute,
      start: zonedTimeToUtc(date, o.startMinute, tz),
      end: zonedTimeToUtc(date, o.endMinute, tz),
      modified: false,
      extra: true,
      note: o.note,
    });
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime() || a.subject.localeCompare(b.subject));
}

/** Occurrences for every date in [from, to] (inclusive). */
export function occurrencesBetween(
  from: string,
  to: string,
  slots: SlotLike[],
  overrides: OverrideLike[],
  tz: string
): Occurrence[] {
  const out: Occurrence[] = [];
  const n = daysBetween(from, to);
  for (let i = 0; i <= n; i++) out.push(...occurrencesOn(addDays(from, i), slots, overrides, tz));
  return out;
}

// ------------------------------------------------------------ live window

export type OccurrencePhase = 'upcoming' | 'open' | 'past';

/**
 * upcoming: before the waiting room opens (start − early);
 * open: waiting room open, through the whole class (late joining allowed until the end);
 * past: at/after the scheduled end.
 */
export function phaseOf(occ: { start: Date; end: Date }, now: Date, earlyMinutes: number): OccurrencePhase {
  const opens = occ.start.getTime() - earlyMinutes * 60_000;
  if (now.getTime() < opens) return 'upcoming';
  if (now.getTime() < occ.end.getTime()) return 'open';
  return 'past';
}

export function opensAt(occ: { start: Date }, earlyMinutes: number): Date {
  return new Date(occ.start.getTime() - earlyMinutes * 60_000);
}

export function forAudience<T extends Audience>(items: T[], grade: string, division: string): T[] {
  return items.filter((o) => audienceIncludes(o, grade, division));
}

// --------------------------------------------------------------- overlaps

function rangesOverlap(aFrom: string | null, aTo: string | null, bFrom: string | null, bTo: string | null) {
  const lo = (x: string | null) => x ?? '0000-01-01';
  const hi = (x: string | null) => x ?? '9999-12-31';
  return lo(aFrom) <= hi(bTo) && lo(bFrom) <= hi(aTo);
}

function minutesOverlap(a: { startMinute: number; endMinute: number }, b: { startMinute: number; endMinute: number }) {
  return a.startMinute < b.endMinute && b.startMinute < a.endMinute;
}

export type SlotInput = Omit<SlotLike, 'id'> & { id?: string };

/** Basic field checks; returns an error message or null. */
export function slotProblem(s: SlotInput): string | null {
  if (!normalizeGrade(s.grade)) return 'Grade is required';
  if (!s.allDivisions && !s.divisions.map(normalizeDivision).filter(Boolean).length) {
    return 'Pick at least one division (or all divisions)';
  }
  if (!s.subject.trim()) return 'Subject is required';
  if (!Number.isInteger(s.weekday) || s.weekday < 0 || s.weekday > 6) return 'Pick a weekday';
  if (!(s.startMinute >= 0 && s.endMinute <= 1440 && s.startMinute < s.endMinute)) {
    return 'End time must be after start time';
  }
  if (s.endMinute - s.startMinute < 5) return 'A class must be at least 5 minutes long';
  if (s.effectiveFrom && s.effectiveTo && s.effectiveFrom > s.effectiveTo) {
    return 'Effective "from" date must be before "to" date';
  }
  return null;
}

/**
 * Conflicts of a new/edited slot with existing weekly slots:
 * - teacher: same teacher, same weekday, overlapping time and date range (always refused);
 * - audience: a shared grade-division at the same time (refused unless the admin confirms).
 */
export function slotConflicts(candidate: SlotInput, existing: SlotLike[]) {
  const teacher: SlotLike[] = [];
  const audience: SlotLike[] = [];
  for (const s of existing) {
    if (candidate.id && s.id === candidate.id) continue;
    if (s.weekday !== candidate.weekday) continue;
    if (!minutesOverlap(s, candidate)) continue;
    if (!rangesOverlap(s.effectiveFrom, s.effectiveTo, candidate.effectiveFrom, candidate.effectiveTo)) continue;
    if (s.teacherId === candidate.teacherId) teacher.push(s);
    else if (audiencesOverlap(s, candidate)) audience.push(s);
  }
  return { teacher, audience };
}

/** Clashes among one day's occurrences (used to validate overrides). */
export function occurrenceConflicts(occs: Occurrence[]) {
  const teacher: [Occurrence, Occurrence][] = [];
  const audience: [Occurrence, Occurrence][] = [];
  for (let i = 0; i < occs.length; i++) {
    for (let j = i + 1; j < occs.length; j++) {
      const a = occs[i]!;
      const b = occs[j]!;
      if (a.date !== b.date || !minutesOverlap(a, b)) continue;
      if (a.teacherId === b.teacherId) teacher.push([a, b]);
      else if (audiencesOverlap(a, b)) audience.push([a, b]);
    }
  }
  return { teacher, audience };
}

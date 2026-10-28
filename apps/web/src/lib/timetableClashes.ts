/**
 * Weekly slots that collide: same day, overlapping times, overlapping date
 * ranges, and either the same teacher or the same class (campus + grade with a
 * shared division, or a whole-grade slot). Shown on the admin timetable so
 * clashes are visible at a glance; saving one still asks the admin to confirm.
 */
export type ClashSlot = {
  id: string;
  teacherId: string;
  campus: string;
  grade: string;
  divisions: string[];
  allDivisions: boolean;
  weekday: number;
  start: string;
  end: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
};

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function datesOverlap(a: ClashSlot, b: ClashSlot): boolean {
  const aFrom = a.effectiveFrom ?? '0000-01-01';
  const aTo = a.effectiveTo ?? '9999-12-31';
  const bFrom = b.effectiveFrom ?? '0000-01-01';
  const bTo = b.effectiveTo ?? '9999-12-31';
  return aFrom <= bTo && bFrom <= aTo;
}

function sameClass(a: ClashSlot, b: ClashSlot): boolean {
  if (a.campus !== b.campus || a.grade !== b.grade) return false;
  if (a.allDivisions || b.allDivisions) return true;
  return a.divisions.some((d) => b.divisions.includes(d));
}

export function slotsClash(a: ClashSlot, b: ClashSlot): boolean {
  if (a.id === b.id || a.weekday !== b.weekday) return false;
  if (!(minutes(a.start) < minutes(b.end) && minutes(b.start) < minutes(a.end))) return false;
  if (!datesOverlap(a, b)) return false;
  return a.teacherId === b.teacherId || sameClass(a, b);
}

/** Ids of every slot that clashes with at least one other. */
export function slotClashes(slots: ClashSlot[]): Set<string> {
  const out = new Set<string>();
  const byDay = new Map<number, ClashSlot[]>();
  for (const s of slots) byDay.set(s.weekday, [...(byDay.get(s.weekday) ?? []), s]);
  for (const day of byDay.values()) {
    for (let i = 0; i < day.length; i++) {
      for (let j = i + 1; j < day.length; j++) {
        if (slotsClash(day[i]!, day[j]!)) {
          out.add(day[i]!.id);
          out.add(day[j]!.id);
        }
      }
    }
  }
  return out;
}

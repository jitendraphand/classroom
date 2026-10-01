import type { ScheduleOverride, TimetableSlot } from '@prisma/client';
import { prisma } from './db';
import {
  addDays,
  dateOnly,
  dateValue,
  occurrencesBetween,
  occurrencesOn,
  type Occurrence,
  type OverrideLike,
  type SlotLike,
} from './schedule';
import { appTimeZone } from './schoolConfig';

export function toSlotLike(s: TimetableSlot): SlotLike {
  return {
    id: s.id,
    teacherId: s.teacherId,
    grade: s.grade,
    divisions: s.divisions,
    allDivisions: s.allDivisions,
    subject: s.subject,
    weekday: s.weekday,
    startMinute: s.startMinute,
    endMinute: s.endMinute,
    effectiveFrom: dateOnly(s.effectiveFrom),
    effectiveTo: dateOnly(s.effectiveTo),
  };
}

export function toOverrideLike(o: ScheduleOverride): OverrideLike {
  return {
    id: o.id,
    kind: o.kind,
    date: dateOnly(o.date)!,
    slotId: o.slotId,
    teacherId: o.teacherId,
    grade: o.grade,
    divisions: o.divisions,
    allDivisions: o.allDivisions,
    subject: o.subject,
    startMinute: o.startMinute,
    endMinute: o.endMinute,
    note: o.note,
  };
}

/** Slots + overrides relevant to [from, to]. */
export async function loadSchedule(from: string, to: string) {
  const [slots, overrides] = await Promise.all([
    prisma.timetableSlot.findMany({
      where: {
        AND: [
          { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: dateValue(to) } }] },
          { OR: [{ effectiveTo: null }, { effectiveTo: { gte: dateValue(from) } }] },
        ],
      },
    }),
    prisma.scheduleOverride.findMany({
      where: { date: { gte: dateValue(from), lte: dateValue(to) } },
    }),
  ]);
  return { slots: slots.map(toSlotLike), overrides: overrides.map(toOverrideLike) };
}

export async function occurrencesForRange(from: string, to: string, tz = appTimeZone()): Promise<Occurrence[]> {
  const { slots, overrides } = await loadSchedule(from, to);
  return occurrencesBetween(from, to, slots, overrides, tz);
}

export async function occurrencesForDate(date: string, tz = appTimeZone()): Promise<Occurrence[]> {
  const { slots, overrides } = await loadSchedule(date, date);
  return occurrencesOn(date, slots, overrides, tz);
}

/** Find one occurrence by its key ("slot:<id>:<date>" / "extra:<overrideId>"). */
export async function findOccurrence(key: string, tz = appTimeZone()): Promise<Occurrence | null> {
  let date: string | null = null;
  const slotMatch = /^slot:([^:]+):(\d{4}-\d{2}-\d{2})$/.exec(key);
  if (slotMatch) date = slotMatch[2]!;
  const extraMatch = /^extra:(.+)$/.exec(key);
  if (extraMatch) {
    const o = await prisma.scheduleOverride.findUnique({ where: { id: extraMatch[1]! } });
    date = o ? dateOnly(o.date) : null;
  }
  if (!date) return null;
  const occs = await occurrencesForDate(date, tz);
  return occs.find((o) => o.key === key) ?? null;
}

export { addDays };

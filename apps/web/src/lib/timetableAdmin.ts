import { z } from 'zod';
import { prisma } from './db';
import { formatAudience, normalizeGrade, parseDivisionList } from './grades';
import {
  WEEKDAYS,
  dateValue,
  formatHHMM,
  isLocalDate,
  occurrenceConflicts,
  occurrencesOn,
  parseHHMM,
  slotConflicts,
  slotProblem,
  weekdayOf,
  type Occurrence,
  type OverrideLike,
  type SlotInput,
  type SlotLike,
} from './schedule';
import { loadSchedule, toSlotLike } from './scheduleService';
import { appTimeZone } from './schoolConfig';

export class TimetableError extends Error {
  constructor(message: string, public status = 400, public extra?: Record<string, unknown>) {
    super(message);
  }
}

const time = z.string().refine((s) => parseHHMM(s) != null, 'Use HH:MM (24-hour) times');
const optDate = z
  .string()
  .optional()
  .nullable()
  .transform((s) => (s ? s : null))
  .refine((s) => s == null || isLocalDate(s), 'Use YYYY-MM-DD dates');

export const slotBody = z.object({
  teacherId: z.string().min(1),
  grade: z.string().min(1).max(16),
  divisions: z.union([z.string().max(200), z.array(z.string().max(16)).max(40)]),
  subject: z.string().trim().min(1).max(80),
  weekday: z.number().int().min(0).max(6),
  start: time,
  end: time,
  effectiveFrom: optDate,
  effectiveTo: optDate,
  /** Admin confirmed a grade-division overlap warning. */
  force: z.boolean().optional(),
});

export type SlotBody = z.infer<typeof slotBody>;

function toInput(b: SlotBody, id?: string): SlotInput {
  const d = parseDivisionList(b.divisions);
  return {
    id,
    teacherId: b.teacherId,
    grade: normalizeGrade(b.grade),
    divisions: d.divisions,
    allDivisions: d.allDivisions,
    subject: b.subject.trim(),
    weekday: b.weekday,
    startMinute: parseHHMM(b.start)!,
    endMinute: parseHHMM(b.end)!,
    effectiveFrom: b.effectiveFrom ?? null,
    effectiveTo: b.effectiveTo ?? null,
  };
}

function describeSlot(s: SlotLike, names: Map<string, string>) {
  return `${WEEKDAYS[s.weekday]} ${formatHHMM(s.startMinute)}–${formatHHMM(s.endMinute)} ${s.subject} (${formatAudience(
    s.grade,
    s.divisions,
    s.allDivisions
  )}, ${names.get(s.teacherId) ?? 'teacher'})`;
}

async function teacherNames() {
  const rows = await prisma.teacher.findMany({ select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function validateSlot(input: SlotInput, force: boolean) {
  const problem = slotProblem(input);
  if (problem) throw new TimetableError(problem);
  const teacher = await prisma.teacher.findUnique({ where: { id: input.teacherId } });
  if (!teacher) throw new TimetableError('Teacher not found', 404);
  const sameDay = (await prisma.timetableSlot.findMany({ where: { weekday: input.weekday } })).map(toSlotLike);
  const c = slotConflicts(input, sameDay);
  const names = await teacherNames();
  if (c.teacher.length) {
    throw new TimetableError(
      `${teacher.name} already teaches at that time: ${c.teacher.map((s) => describeSlot(s, names)).join('; ')}`,
      409,
      { conflict: 'teacher' }
    );
  }
  if (c.audience.length && !force) {
    throw new TimetableError(
      `That grade-division already has a class at that time: ${c.audience.map((s) => describeSlot(s, names)).join('; ')}`,
      409,
      { conflict: 'audience', canForce: true }
    );
  }
}

function slotData(input: SlotInput) {
  return {
    teacherId: input.teacherId,
    grade: input.grade,
    divisions: input.divisions,
    allDivisions: input.allDivisions,
    subject: input.subject,
    weekday: input.weekday,
    startMinute: input.startMinute,
    endMinute: input.endMinute,
    effectiveFrom: input.effectiveFrom ? dateValue(input.effectiveFrom) : null,
    effectiveTo: input.effectiveTo ? dateValue(input.effectiveTo) : null,
  };
}

export async function createSlot(body: SlotBody) {
  const input = toInput(body);
  await validateSlot(input, !!body.force);
  return prisma.timetableSlot.create({ data: slotData(input) });
}

export async function updateSlot(id: string, body: SlotBody) {
  const existing = await prisma.timetableSlot.findUnique({ where: { id } });
  if (!existing) throw new TimetableError('Slot not found', 404);
  const input = toInput(body, id);
  await validateSlot(input, !!body.force);
  return prisma.timetableSlot.update({ where: { id }, data: slotData(input) });
}

export async function deleteSlot(id: string) {
  const existing = await prisma.timetableSlot.findUnique({ where: { id } });
  if (!existing) throw new TimetableError('Slot not found', 404);
  // Overrides cascade; held ClassSessions keep their history (slotId → null).
  await prisma.timetableSlot.delete({ where: { id } });
}

// --------------------------------------------------------------- overrides

export const overrideBody = z.object({
  kind: z.enum(['CANCEL', 'MODIFY', 'EXTRA']),
  date: z.string().refine(isLocalDate, 'Use a YYYY-MM-DD date'),
  slotId: z.string().optional().nullable(),
  teacherId: z.string().optional().nullable(),
  grade: z.string().max(16).optional().nullable(),
  divisions: z.union([z.string().max(200), z.array(z.string().max(16)).max(40)]).optional().nullable(),
  subject: z.string().max(80).optional().nullable(),
  start: z.string().optional().nullable(),
  end: z.string().optional().nullable(),
  note: z.string().max(200).optional().nullable(),
  force: z.boolean().optional(),
});
export type OverrideBody = z.infer<typeof overrideBody>;

function minuteOrNull(s: string | null | undefined, label: string): number | null {
  if (!s) return null;
  const m = parseHHMM(s);
  if (m == null) throw new TimetableError(`${label}: use HH:MM (24-hour)`);
  return m;
}

function describeOcc(o: Occurrence, names: Map<string, string>) {
  return `${formatHHMM(o.startMinute)}–${formatHHMM(o.endMinute)} ${o.subject} (${formatAudience(
    o.grade,
    o.divisions,
    o.allDivisions
  )}, ${names.get(o.teacherId) ?? 'teacher'})`;
}

export async function createOverride(body: OverrideBody) {
  const startMinute = minuteOrNull(body.start, 'Start');
  const endMinute = minuteOrNull(body.end, 'End');
  const div = body.divisions != null && body.divisions !== '' ? parseDivisionList(body.divisions) : null;
  const grade = body.grade ? normalizeGrade(body.grade) : null;
  const subject = body.subject?.trim() || null;
  const teacherId = body.teacherId || null;

  if (teacherId && !(await prisma.teacher.findUnique({ where: { id: teacherId } }))) {
    throw new TimetableError('Teacher not found', 404);
  }

  let slot = null;
  if (body.kind !== 'EXTRA') {
    if (!body.slotId) throw new TimetableError('Pick the timetable slot to change');
    slot = await prisma.timetableSlot.findUnique({ where: { id: body.slotId } });
    if (!slot) throw new TimetableError('Slot not found', 404);
    const s = toSlotLike(slot);
    if (s.weekday !== weekdayOf(body.date)) {
      throw new TimetableError(`That slot is on ${WEEKDAYS[s.weekday]}s; ${body.date} is a ${WEEKDAYS[weekdayOf(body.date)]}.`);
    }
    if ((s.effectiveFrom && body.date < s.effectiveFrom) || (s.effectiveTo && body.date > s.effectiveTo)) {
      throw new TimetableError('That slot is not in effect on this date');
    }
  }

  if (body.kind === 'MODIFY') {
    if (!teacherId && startMinute == null && endMinute == null && !subject && !grade) {
      throw new TimetableError('Change at least one thing: substitute teacher, time, subject or audience');
    }
    if (grade && !div) throw new TimetableError('Give the divisions for the changed audience');
  }
  if (body.kind === 'EXTRA') {
    if (!teacherId) throw new TimetableError('Pick the teacher for the extra class');
    if (!grade || !div || (!div.allDivisions && !div.divisions.length)) {
      throw new TimetableError('Give the grade and divisions for the extra class');
    }
    if (startMinute == null || endMinute == null) throw new TimetableError('Give start and end times');
    if (!subject) throw new TimetableError('Give a subject');
  }
  const effStart = startMinute ?? slot?.startMinute ?? 0;
  const effEnd = endMinute ?? slot?.endMinute ?? 0;
  if (body.kind !== 'CANCEL' && !(effStart < effEnd && effEnd <= 1440)) {
    throw new TimetableError('End time must be after start time');
  }

  const data = {
    kind: body.kind,
    date: dateValue(body.date),
    slotId: body.kind === 'EXTRA' ? null : body.slotId!,
    teacherId: body.kind === 'CANCEL' ? null : teacherId,
    grade: body.kind === 'CANCEL' ? null : grade,
    divisions: body.kind === 'CANCEL' ? [] : div?.divisions ?? [],
    allDivisions: body.kind === 'CANCEL' ? false : div?.allDivisions ?? false,
    subject: body.kind === 'CANCEL' ? null : subject,
    startMinute: body.kind === 'CANCEL' ? null : startMinute,
    endMinute: body.kind === 'CANCEL' ? null : endMinute,
    note: body.note?.trim() || null,
  };

  // Conflict check on that date with the change applied.
  if (body.kind !== 'CANCEL') {
    const { slots, overrides } = await loadSchedule(body.date, body.date);
    const candidate: OverrideLike = { ...data, id: '__candidate__', date: body.date, kind: body.kind };
    const others = overrides.filter((o) => !(data.slotId && o.slotId === data.slotId && o.kind !== 'EXTRA'));
    const occs = occurrencesOn(body.date, slots, [...others, candidate], appTimeZone());
    const changedKey = body.kind === 'EXTRA' ? 'extra:__candidate__' : `slot:${data.slotId}:${body.date}`;
    const c = occurrenceConflicts(occs);
    const involves = (pair: [Occurrence, Occurrence]) => pair.some((o) => o.key === changedKey);
    const names = await teacherNames();
    const t = c.teacher.filter(involves);
    if (t.length) {
      const other = t[0]!.find((o) => o.key !== changedKey)!;
      throw new TimetableError(`The teacher already has a class then: ${describeOcc(other, names)}`, 409, { conflict: 'teacher' });
    }
    const a = c.audience.filter(involves);
    if (a.length && !body.force) {
      const other = a[0]!.find((o) => o.key !== changedKey)!;
      throw new TimetableError(`That grade-division already has a class then: ${describeOcc(other, names)}`, 409, {
        conflict: 'audience',
        canForce: true,
      });
    }
  }

  if (data.slotId) {
    // One change per slot per date: replace any earlier override for it.
    return prisma.scheduleOverride.upsert({
      where: { slotId_date: { slotId: data.slotId, date: data.date } },
      create: data,
      update: data,
    });
  }
  return prisma.scheduleOverride.create({ data });
}

export async function deleteOverride(id: string) {
  const o = await prisma.scheduleOverride.findUnique({ where: { id } });
  if (!o) throw new TimetableError('Override not found', 404);
  await prisma.scheduleOverride.delete({ where: { id } });
}

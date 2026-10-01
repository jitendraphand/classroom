import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/adminGuard';
import { audienceIncludes, formatAudience, normalizeDivision, normalizeGrade } from '@/lib/grades';
import { jsonOk } from '@/lib/response';
import { addDays, dateOnly, dateValue, formatHHMM, localDateOf } from '@/lib/schedule';
import { appTimeZone } from '@/lib/schoolConfig';

export const dynamic = 'force-dynamic';

/**
 * Weekly timetable for the admin editor, filtered by teacher or grade(-division),
 * plus overrides in the next 60 days (or ?from&to) and the teacher list.
 */
export async function GET(req: Request) {
  const { res } = await requireAdminApi();
  if (res) return res;
  const url = new URL(req.url);
  const teacherId = url.searchParams.get('teacherId') || undefined;
  const grade = url.searchParams.get('grade') ? normalizeGrade(url.searchParams.get('grade')) : undefined;
  const division = url.searchParams.get('division') ? normalizeDivision(url.searchParams.get('division')) : undefined;
  const tz = appTimeZone();
  const today = localDateOf(new Date(), tz);
  const from = url.searchParams.get('from') || addDays(today, -7);
  const to = url.searchParams.get('to') || addDays(today, 60);

  const [teachers, slotRows, overrideRows] = await Promise.all([
    prisma.teacher.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, disabled: true, assignments: { select: { grade: true, division: true } } },
    }),
    prisma.timetableSlot.findMany({
      where: { ...(teacherId ? { teacherId } : {}), ...(grade ? { grade } : {}) },
      orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
    }),
    prisma.scheduleOverride.findMany({
      where: { date: { gte: dateValue(from), lte: dateValue(to) } },
      orderBy: [{ date: 'asc' }, { startMinute: 'asc' }],
      include: { slot: true },
    }),
  ]);
  const names = new Map(teachers.map((t) => [t.id, t.name]));
  const slots = slotRows
    .filter((s) => !division || audienceIncludes(s, s.grade, division))
    .map((s) => ({
      id: s.id,
      teacherId: s.teacherId,
      teacherName: names.get(s.teacherId) ?? '—',
      grade: s.grade,
      divisions: s.divisions,
      allDivisions: s.allDivisions,
      audience: formatAudience(s.grade, s.divisions, s.allDivisions),
      subject: s.subject,
      weekday: s.weekday,
      start: formatHHMM(s.startMinute),
      end: formatHHMM(s.endMinute),
      effectiveFrom: dateOnly(s.effectiveFrom),
      effectiveTo: dateOnly(s.effectiveTo),
    }));
  const overrides = overrideRows.map((o) => ({
    id: o.id,
    kind: o.kind,
    date: dateOnly(o.date),
    slotId: o.slotId,
    slotLabel: o.slot
      ? `${o.slot.subject} ${formatHHMM(o.slot.startMinute)}–${formatHHMM(o.slot.endMinute)} · ${formatAudience(
          o.slot.grade,
          o.slot.divisions,
          o.slot.allDivisions
        )} · ${names.get(o.slot.teacherId) ?? ''}`
      : null,
    teacherName: o.teacherId ? names.get(o.teacherId) ?? '—' : null,
    audience: o.grade ? formatAudience(o.grade, o.divisions, o.allDivisions) : null,
    subject: o.subject,
    start: o.startMinute != null ? formatHHMM(o.startMinute) : null,
    end: o.endMinute != null ? formatHHMM(o.endMinute) : null,
    note: o.note,
  }));
  return jsonOk({
    timezone: tz,
    today,
    teachers: teachers.map((t) => ({ id: t.id, name: t.name, disabled: t.disabled, assignments: t.assignments })),
    slots,
    overrides,
  });
}

import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { displayAssignment, formatAudience } from '@/lib/grades';
import { jsonError, jsonOk } from '@/lib/response';
import { addDays, formatHHMM, localDateOf, opensAt, phaseOf } from '@/lib/schedule';
import { occurrencesForRange } from '@/lib/scheduleService';
import { appTimeZone, earlyWindowMinutes } from '@/lib/schoolConfig';
import { getTeacherAssignments } from '@/lib/teachers';
import { loadMaster } from '@/lib/gradeMaster';
import { teacherGradeChoices } from '@/lib/gradeMasterLogic';

export const dynamic = 'force-dynamic';

/** The signed-in teacher's classes today + next 6 days, with start eligibility. */
export async function GET() {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);

  const tz = appTimeZone();
  const early = earlyWindowMinutes();
  const now = new Date();
  const today = localDateOf(now, tz);
  const occs = (await occurrencesForRange(today, addDays(today, 6), tz)).filter(
    (o) => o.teacherId === teacher.id || o.originalTeacherId === teacher.id
  );

  const [sessions, room, assignments, master] = await Promise.all([
    prisma.classSession.findMany({ where: { occurrenceKey: { in: occs.map((o) => o.key) } } }),
    prisma.room.findUnique({ where: { code: teacher.permanentCode } }),
    getTeacherAssignments(teacher.id),
    loadMaster(),
  ]);
  const byKey = new Map(sessions.map((s) => [s.occurrenceKey, s]));
  const otherTeacherIds = [...new Set(occs.flatMap((o) => [o.teacherId, o.originalTeacherId]).filter((x): x is string => !!x && x !== teacher.id))];
  const names = new Map(
    (await prisma.teacher.findMany({ where: { id: { in: otherTeacherIds } }, select: { id: true, name: true } })).map((t) => [t.id, t.name])
  );
  const activeId = room && room.status !== 'ENDED' ? room.classSessionId : null;

  const classes = occs.map((o) => {
    const s = byKey.get(o.key);
    const phase = phaseOf(o, now, early);
    const mine = o.teacherId === teacher.id;
    return {
      key: o.key,
      date: o.date,
      subject: o.subject,
      audience: formatAudience(o.campus, o.grade, o.divisions, o.allDivisions),
      start: o.start.toISOString(),
      end: o.end.toISOString(),
      startLabel: formatHHMM(o.startMinute),
      endLabel: formatHHMM(o.endMinute),
      opensAt: opensAt(o, early).toISOString(),
      phase,
      mine,
      substituteFor: mine && o.originalTeacherId ? names.get(o.originalTeacherId) ?? 'another teacher' : null,
      coveredBy: !mine ? names.get(o.teacherId) ?? 'another teacher' : null,
      extra: o.extra,
      note: o.note,
      canStart: mine && (phase === 'open' || (phase === 'past' && !!s?.startedAt && !s.endedAt)),
      session: s
        ? { id: s.id, startedAt: s.startedAt, endedAt: s.endedAt, live: activeId === s.id }
        : null,
    };
  });

  let active = null;
  if (activeId) {
    const cs = await prisma.classSession.findUnique({ where: { id: activeId } });
    if (cs) {
      active = {
        id: cs.id,
        subject: cs.subject,
        audience: formatAudience(cs.campus, cs.grade, cs.divisions, cs.allDivisions),
        adHoc: cs.adHoc,
        code: room!.code,
      };
    }
  } else if (room && room.status !== 'ENDED') {
    active = { id: null, subject: room.name, audience: '', adHoc: true, code: room.code };
  }

  return jsonOk({
    timezone: tz,
    earlyMinutes: early,
    now: now.toISOString(),
    today,
    classes,
    active,
    assignments: assignments.map((a) => ({ ...a, label: displayAssignment(a) })),
    /** Ad-hoc start dropdowns: assigned grades, divisions from Grades & divisions (active only). */
    gradeChoices: teacherGradeChoices(assignments, master),
    gradesConfigured: master.length > 0,
  });
}

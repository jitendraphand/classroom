import { getPupil, refreshPupilCookie } from '@/lib/auth';
import { formatAudience } from '@/lib/grades';
import { jsonError, jsonOk } from '@/lib/response';
import { routeStudent } from '@/lib/studentService';
import { appTimeZone } from '@/lib/schoolConfig';
import { loadMaster } from '@/lib/gradeMaster';
import { studentAudienceStatus } from '@/lib/gradeMasterLogic';

export const dynamic = 'force-dynamic';

/**
 * Where should the signed-in school-app student go now? Checks them in to an
 * open class (attendance + waiting room). POST because it records arrival;
 * called by /student on load and whenever /api/student/check reports a change.
 */
export async function POST() {
  const student = await getPupil();
  if (!student) return jsonError('Open the class from the school app.', 401, { reason: 'missing' });
  try {
    const route = await routeStudent(student);
    // Grade/division the school app sent but Grades & divisions does not know:
    // no class can be found, so say so instead of a plain "No class right now".
    const audienceStatus = studentAudienceStatus(
      await loadMaster().catch(() => []),
      student.grade,
      student.division
    );
    await refreshPupilCookie(student).catch(() => undefined);
    return jsonOk({
      student: {
        name: student.name,
        rollNumber: student.rollNumber,
        gradeDivision: formatAudience(student.campus, student.grade, [student.division], false),
        audienceStatus,
      },
      timezone: appTimeZone(),
      now: new Date().toISOString(),
      ...route,
    });
  } catch (e) {
    console.error('student route failed', e);
    return jsonError('Could not load your classes. Try again in a moment.', 500);
  }
}

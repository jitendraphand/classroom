import { requireAdminApi } from '@/lib/adminGuard';
import { adminPerformance, adminTeacherSessions } from '@/lib/adminBoard';
import { isAcademicYearLabel } from '@/lib/academicYear';
import { jsonError, jsonOk } from '@/lib/response';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { res } = await requireAdminApi('viewReports');
  if (res) return res;
  const url = new URL(req.url);
  const teacherId = url.searchParams.get('sessionsFor');
  if (teacherId) {
    const year = url.searchParams.get('year') || '';
    if (!isAcademicYearLabel(year)) return jsonError('Pick an academic year');
    return jsonOk({ sessions: await adminTeacherSessions(teacherId, year) });
  }
  return jsonOk(await adminPerformance(url));
}

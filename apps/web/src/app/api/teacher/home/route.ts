import { getTeacherSession } from '@/lib/auth';
import { buildTeacherHome } from '@/lib/teacherHome';
import { jsonError, jsonOk } from '@/lib/response';

export const dynamic = 'force-dynamic';

/** Teacher dashboard data. Written feedback is never selected. */
export async function GET(req: Request) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);
  const data = await buildTeacherHome(teacher.id, new URL(req.url));
  return jsonOk(data);
}

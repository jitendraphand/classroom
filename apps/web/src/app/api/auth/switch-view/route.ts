import { prisma } from '@/lib/db';
import {
  clearAdminCookie,
  clearTeacherCookie,
  getAdminSession,
  getTeacherSession,
  setAdminCookie,
  setTeacherCookie,
  startLinkedAdminSession,
  startTeacherSession,
} from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';

export const dynamic = 'force-dynamic';

/**
 * Teacher ⇄ admin view for a teacher who holds a sub-admin role. One login
 * (the teacher's); this browser holds one of the two cookies at a time, so
 * every page and the classroom resolve the role exactly as before.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { to?: unknown } | null;
  if (body?.to === 'admin') {
    const teacher = await getTeacherSession();
    if (!teacher) return jsonError('Unauthorized', 401);
    const link = await prisma.admin.findUnique({ where: { teacherId: teacher.id } });
    if (!link || link.kind !== 'SUB') return jsonError('You do not have an admin role', 403);
    const t = await prisma.teacher.findUnique({ where: { id: teacher.id } });
    if (!t) return jsonError('Unauthorized', 401);
    await setAdminCookie(await startLinkedAdminSession(link.id, t.sessionVersion));
    await clearTeacherCookie();
    return jsonOk({ role: 'admin', to: '/admin' });
  }
  if (body?.to === 'teacher') {
    const admin = await getAdminSession();
    if (!admin?.linkedTeacherId) return jsonError('Unauthorized', 401);
    await setTeacherCookie(await startTeacherSession(admin.linkedTeacherId));
    await clearAdminCookie();
    return jsonOk({ role: 'teacher', to: '/teacher/dashboard' });
  }
  return jsonError('Choose admin or teacher');
}

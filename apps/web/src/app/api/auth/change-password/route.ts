import { z } from 'zod';
import { prisma } from '@/lib/db';
import {
  createAdminToken,
  createTeacherToken,
  getAdminSession,
  getTeacherSession,
  hashPassword,
  setAdminCookie,
  setTeacherCookie,
  verifyPassword,
} from '@/lib/auth';
import { passwordProblem } from '@/lib/passwords';
import { jsonError, jsonOk } from '@/lib/response';

const schema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

/**
 * Change own password (admin or teacher). Also the only API a teacher/admin
 * with a pending forced change (temporary password) can call besides /me.
 * Bumps the session version so every other session of the account ends, then
 * re-issues this browser's cookie.
 */
export async function POST(req: Request) {
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch {
    return jsonError('Enter your current and new password');
  }

  const admin = await getAdminSession({ allowPendingPasswordChange: true });
  if (admin) {
    const row = await prisma.admin.findUnique({ where: { id: admin.id } });
    if (!row || !(await verifyPassword(body.currentPassword, row.passwordHash))) {
      return jsonError('Current password is incorrect', 400);
    }
    const problem = passwordProblem(body.newPassword, { email: row.email, current: body.currentPassword });
    if (problem) return jsonError(problem, 400);
    const updated = await prisma.admin.update({
      where: { id: row.id },
      data: {
        passwordHash: await hashPassword(body.newPassword),
        mustChangePassword: false,
        sessionVersion: { increment: 1 },
      },
    });
    await setAdminCookie(await createAdminToken(updated));
    return jsonOk({ ok: true, role: 'admin' });
  }

  const teacher = await getTeacherSession({ allowPendingPasswordChange: true });
  if (teacher) {
    const row = await prisma.teacher.findUnique({ where: { id: teacher.id } });
    if (!row || !(await verifyPassword(body.currentPassword, row.passwordHash))) {
      return jsonError('Current password is incorrect', 400);
    }
    const problem = passwordProblem(body.newPassword, { email: row.email, current: body.currentPassword });
    if (problem) return jsonError(problem, 400);
    const updated = await prisma.teacher.update({
      where: { id: row.id },
      data: {
        passwordHash: await hashPassword(body.newPassword),
        mustChangePassword: false,
        sessionVersion: { increment: 1 },
      },
    });
    await setTeacherCookie(await createTeacherToken(updated));
    return jsonOk({ ok: true, role: 'teacher' });
  }

  return jsonError('Unauthorized', 401);
}

import { prisma } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { requireAdminApi } from '@/lib/adminGuard';
import { generatePassword } from '@/lib/passwords';
import { parsePrivilegeBody, privilegeSetFrom } from '@/lib/privileges';
import { jsonError, jsonOk } from '@/lib/response';
import { mutateSubAdminDenied, rejectedKindChange, resolveNewSubAdminPassword } from '@/lib/subAdminAccounts';

export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { res } = await requireAdminApi('SYSTEM');
  if (res) return res;
  const id = (await params).id;
  const found = mutateSubAdminDenied(await prisma.admin.findUnique({ where: { id } }), { action: 'edit' });
  if (!found.ok) return jsonError(found.error, found.status);
  const row = found.row;
  const body = (await req.json().catch(() => null)) as { name?: unknown; privileges?: unknown; resetPassword?: unknown; password?: unknown } | null;
  const kindProblem = rejectedKindChange(body);
  if (kindProblem) return jsonError(kindProblem, 403);
  const data: {
    name?: string;
    privManageTeachers?: boolean;
    privSchedule?: boolean;
    privMonitorLive?: boolean;
    privViewReports?: boolean;
    privManageSchool?: boolean;
    sessionVersion?: { increment: number };
    passwordHash?: string;
    mustChangePassword?: boolean;
  } = {};
  if (typeof body?.name === 'string' && body.name.trim()) data.name = body.name.trim().slice(0, 80);
  if (body?.privileges !== undefined) {
    const privileges = parsePrivilegeBody(body.privileges);
    if (!privileges) return jsonError('Set each privilege to true or false');
    data.privManageTeachers = privileges.manageTeachers;
    data.privSchedule = privileges.schedule;
    data.privMonitorLive = privileges.monitorLive;
    data.privViewReports = privileges.viewReports;
    data.privManageSchool = privileges.manageSchool;
    data.sessionVersion = { increment: 1 };
  }
  let temporaryPassword: string | undefined;
  if (body?.resetPassword === true && row.teacherId) {
    return jsonError("This sub-administrator signs in with their teacher account; reset the teacher's password on the Teachers page", 400);
  }
  if (body?.resetPassword === true) {
    const resolved = resolveNewSubAdminPassword(body?.password, { email: row.email });
    if (!resolved.ok) return jsonError(resolved.error);
    temporaryPassword = resolved.generated ? resolved.password : undefined;
    data.passwordHash = await hashPassword(resolved.password);
    data.mustChangePassword = resolved.mustChangePassword;
    data.sessionVersion = { increment: 1 };
  }
  const updated = await prisma.admin.update({ where: { id }, data });
  return jsonOk(
    { admin: { id: updated.id, email: updated.email, name: updated.name, kind: updated.kind, privileges: privilegeSetFrom(updated) }, temporaryPassword },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { res, admin } = await requireAdminApi('SYSTEM');
  if (res) return res;
  const id = (await params).id;
  const found = mutateSubAdminDenied(await prisma.admin.findUnique({ where: { id } }), { actorId: admin.id, action: 'delete' });
  if (!found.ok) return jsonError(found.error, found.status);
  // Only the admin role goes; a linked teacher account (found.row.teacherId) stays as it is.
  await prisma.admin.delete({ where: { id } });
  return jsonOk({ ok: true, teacherKept: !!found.row.teacherId });
}

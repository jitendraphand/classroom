import { prisma } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { requireAdminApi } from '@/lib/adminGuard';
import { generatePassword } from '@/lib/passwords';
import { parsePrivilegeBody, privilegeSetFrom } from '@/lib/privileges';
import { jsonError, jsonOk } from '@/lib/response';

export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { res } = await requireAdminApi('SYSTEM');
  if (res) return res;
  const id = (await params).id;
  const row = await prisma.admin.findUnique({ where: { id } });
  if (!row) return jsonError('Administrator not found', 404);
  if (row.kind !== 'SUB') return jsonError('The system administrator is not edited here', 403);
  const body = (await req.json().catch(() => null)) as { name?: unknown; privileges?: unknown; resetPassword?: unknown } | null;
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
  if (body?.resetPassword === true) {
    temporaryPassword = generatePassword();
    data.passwordHash = await hashPassword(temporaryPassword);
    data.mustChangePassword = true;
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
  if (id === admin.id) return jsonError('You cannot delete your own account', 403);
  const row = await prisma.admin.findUnique({ where: { id } });
  if (!row) return jsonError('Administrator not found', 404);
  if (row.kind !== 'SUB') return jsonError('The system administrator cannot be deleted', 403);
  await prisma.admin.delete({ where: { id } });
  return jsonOk({ ok: true });
}

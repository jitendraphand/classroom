import { prisma } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { requireAdminApi } from '@/lib/adminGuard';
import { generatePassword } from '@/lib/passwords';
import { parsePrivilegeBody, privilegeSetFrom, PRIVILEGE_LABELS } from '@/lib/privileges';
import { jsonError, jsonOk } from '@/lib/response';

export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function view(row: {
  id: string;
  email: string;
  name: string;
  kind: 'SYSTEM' | 'SUB';
  mustChangePassword: boolean;
  privManageTeachers: boolean;
  privSchedule: boolean;
  privMonitorLive: boolean;
  privViewReports: boolean;
  privManageSchool: boolean;
  teacherId?: string | null;
  teacher?: { name: string; email: string } | null;
}) {
  return {
    id: row.id,
    // A teacher's role shows the teacher's own sign-in email (the row's email is an internal placeholder).
    email: row.teacher?.email ?? row.email,
    name: row.teacher?.name ?? row.name,
    teacherId: row.teacherId ?? null,
    kind: row.kind,
    mustChangePassword: row.mustChangePassword,
    privileges: privilegeSetFrom(row),
  };
}

export async function GET() {
  const { res } = await requireAdminApi('SYSTEM');
  if (res) return res;
  const rows = await prisma.admin.findMany({
    orderBy: [{ kind: 'asc' }, { email: 'asc' }],
    include: { teacher: { select: { name: true, email: true } } },
  });
  return jsonOk({ admins: rows.map(view), labels: PRIVILEGE_LABELS });
}

export async function POST(req: Request) {
  const { res, admin } = await requireAdminApi('SYSTEM');
  if (res) return res;
  const body = (await req.json().catch(() => null)) as {
    name?: unknown;
    email?: unknown;
    privileges?: unknown;
    teacherId?: unknown;
  } | null;
  if (typeof body?.teacherId === 'string' && body.teacherId) {
    return createForTeacher(body.teacherId, body.privileges);
  }
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!name || name.length > 80) return jsonError('Name is required');
  if (!EMAIL_RE.test(email)) return jsonError('Enter a valid email');
  const privileges = parsePrivilegeBody(body?.privileges);
  if (!privileges) return jsonError('Set each privilege to true or false');
  if (email === admin.email) return jsonError('That email is already the system administrator');
  const teacher = await prisma.teacher.findUnique({ where: { email } });
  if (teacher) return jsonError('That email belongs to a teacher. Choose "Existing teacher" to give them admin privileges.');
  const taken = await prisma.admin.findUnique({ where: { email } });
  if (taken) return jsonError('An administrator with that email already exists', 409);
  const temporaryPassword = generatePassword();
  const row = await prisma.admin.create({
    data: {
      email,
      name,
      kind: 'SUB',
      passwordHash: await hashPassword(temporaryPassword),
      mustChangePassword: true,
      privManageTeachers: privileges.manageTeachers,
      privSchedule: privileges.schedule,
      privMonitorLive: privileges.monitorLive,
      privViewReports: privileges.viewReports,
      privManageSchool: privileges.manageSchool,
    },
  });
  return jsonOk({ admin: view(row), temporaryPassword }, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Give an existing teacher a sub-admin role. No new password: the teacher
 * signs in as usual and switches to the admin view. Deleting the role later
 * removes only this Admin row; the teacher account is untouched.
 */
async function createForTeacher(teacherId: string, rawPrivileges: unknown) {
  const privileges = parsePrivilegeBody(rawPrivileges);
  if (!privileges) return jsonError('Set each privilege to true or false');
  const teacher = await prisma.teacher.findUnique({ where: { id: teacherId } });
  if (!teacher || teacher.deletedAt) return jsonError('Teacher not found', 404);
  if (teacher.disabled) return jsonError('That teacher is disabled');
  const existing = await prisma.admin.findUnique({ where: { teacherId } });
  if (existing) return jsonError(`${teacher.name} is already a sub-administrator`, 409);
  const row = await prisma.admin.create({
    data: {
      // Placeholder, never a login: sign-in skips linked rows and uses the teacher's email.
      email: `teacher-${teacher.id}@linked.invalid`,
      name: teacher.name,
      kind: 'SUB',
      teacherId: teacher.id,
      // Unusable hash of random bytes; this row has no password of its own.
      passwordHash: await hashPassword(generatePassword() + generatePassword()),
      mustChangePassword: false,
      privManageTeachers: privileges.manageTeachers,
      privSchedule: privileges.schedule,
      privMonitorLive: privileges.monitorLive,
      privViewReports: privileges.viewReports,
      privManageSchool: privileges.manageSchool,
    },
    include: { teacher: { select: { name: true, email: true } } },
  });
  return jsonOk({ admin: view(row) }, { headers: { 'Cache-Control': 'no-store' } });
}

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
}) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    kind: row.kind,
    mustChangePassword: row.mustChangePassword,
    privileges: privilegeSetFrom(row),
  };
}

export async function GET() {
  const { res } = await requireAdminApi('SYSTEM');
  if (res) return res;
  const rows = await prisma.admin.findMany({ orderBy: [{ kind: 'asc' }, { email: 'asc' }] });
  return jsonOk({ admins: rows.map(view), labels: PRIVILEGE_LABELS });
}

export async function POST(req: Request) {
  const { res, admin } = await requireAdminApi('SYSTEM');
  if (res) return res;
  const body = (await req.json().catch(() => null)) as { name?: unknown; email?: unknown; privileges?: unknown } | null;
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!name || name.length > 80) return jsonError('Name is required');
  if (!EMAIL_RE.test(email)) return jsonError('Enter a valid email');
  const privileges = parsePrivilegeBody(body?.privileges);
  if (!privileges) return jsonError('Set each privilege to true or false');
  if (email === admin.email) return jsonError('That email is already the system administrator');
  const teacher = await prisma.teacher.findUnique({ where: { email } });
  if (teacher) return jsonError('That email belongs to a teacher');
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

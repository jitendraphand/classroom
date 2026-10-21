import { requireAdminApi } from '@/lib/adminGuard';
import { getSchoolSettings, updateSchoolSettings } from '@/lib/schoolSettings';
import { jsonError, jsonOk } from '@/lib/response';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { res } = await requireAdminApi('manageSchool');
  if (res) return res;
  return jsonOk(await getSchoolSettings());
}

export async function PUT(req: Request) {
  const { res } = await requireAdminApi('manageSchool');
  if (res) return res;
  const body = (await req.json().catch(() => null)) as {
    maxOpenStudentMics?: unknown;
    maxStudentsPerClass?: unknown;
  } | null;
  if (!body) return jsonError('Invalid JSON');
  const patch: { maxOpenStudentMics?: number; maxStudentsPerClass?: number | null } = {};
  if (body.maxOpenStudentMics !== undefined) {
    if (typeof body.maxOpenStudentMics !== 'number' || !Number.isFinite(body.maxOpenStudentMics)) {
      return jsonError('maxOpenStudentMics must be a number (0 = no cap)');
    }
    patch.maxOpenStudentMics = body.maxOpenStudentMics;
  }
  if (body.maxStudentsPerClass !== undefined) {
    if (body.maxStudentsPerClass === null) patch.maxStudentsPerClass = null;
    else if (typeof body.maxStudentsPerClass !== 'number' || !Number.isFinite(body.maxStudentsPerClass)) {
      return jsonError('maxStudentsPerClass must be a number or null (empty = no cap)');
    } else patch.maxStudentsPerClass = body.maxStudentsPerClass;
  }
  return jsonOk(await updateSchoolSettings(patch));
}

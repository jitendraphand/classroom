import { requireAdminApi } from '@/lib/adminGuard';
import { clearSchoolSettingsCache, getSchoolSettings, updateSchoolSettings } from '@/lib/schoolSettings';
import { jsonError, jsonOk } from '@/lib/response';
import { reconcileMicLimit } from '@/lib/micSlotService';

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
  clearSchoolSettingsCache();
  const before = await getSchoolSettings();
  const saved = await updateSchoolSettings(patch);
  // Mic limit changed: recount every live class from who is unmuted right now.
  if (saved.maxOpenStudentMics !== before.maxOpenStudentMics) {
    const r = await reconcileMicLimit(saved.maxOpenStudentMics).catch((e) => {
      console.error('mic limit reconcile', e);
      return null;
    });
    return jsonOk({ ...saved, micRecount: r });
  }
  return jsonOk(saved);
}

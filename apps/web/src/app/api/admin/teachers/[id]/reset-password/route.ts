import { requireAdminApi } from '@/lib/adminGuard';
import { jsonError, jsonOk } from '@/lib/response';
import { resetTeacherPassword, TeacherError } from '@/lib/teachers';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { res } = await requireAdminApi();
  if (res) return res;
  try {
    const { id } = await params;
    const out = await resetTeacherPassword(id);
    return jsonOk(out, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof TeacherError) return jsonError(e.message, e.status);
    console.error(e);
    return jsonError('Could not reset password', 500);
  }
}

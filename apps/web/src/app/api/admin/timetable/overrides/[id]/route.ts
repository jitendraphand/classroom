import { requireAdminApi } from '@/lib/adminGuard';
import { jsonError, jsonOk } from '@/lib/response';
import { deleteOverride, TimetableError } from '@/lib/timetableAdmin';

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { res } = await requireAdminApi();
  if (res) return res;
  try {
    await deleteOverride((await params).id);
    return jsonOk({ ok: true });
  } catch (e) {
    if (e instanceof TimetableError) return jsonError(e.message, e.status);
    console.error(e);
    return jsonError('Could not delete the change', 500);
  }
}

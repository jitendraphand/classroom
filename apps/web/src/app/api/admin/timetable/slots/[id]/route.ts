import { z } from 'zod';
import { requireAdminApi } from '@/lib/adminGuard';
import { jsonError, jsonOk } from '@/lib/response';
import { deleteSlot, slotBody, TimetableError, updateSlot } from '@/lib/timetableAdmin';

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { res } = await requireAdminApi();
  if (res) return res;
  try {
    const slot = await updateSlot((await params).id, slotBody.parse(await req.json()));
    return jsonOk({ slot });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    if (e instanceof TimetableError) return jsonError(e.message, e.status, e.extra);
    console.error(e);
    return jsonError('Could not save the slot', 500);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { res } = await requireAdminApi();
  if (res) return res;
  try {
    await deleteSlot((await params).id);
    return jsonOk({ ok: true });
  } catch (e) {
    if (e instanceof TimetableError) return jsonError(e.message, e.status);
    console.error(e);
    return jsonError('Could not delete the slot', 500);
  }
}

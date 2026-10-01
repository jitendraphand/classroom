import { z } from 'zod';
import { requireAdminApi } from '@/lib/adminGuard';
import { jsonError, jsonOk } from '@/lib/response';
import { createOverride, overrideBody, TimetableError } from '@/lib/timetableAdmin';

export async function POST(req: Request) {
  const { res } = await requireAdminApi();
  if (res) return res;
  try {
    const override = await createOverride(overrideBody.parse(await req.json()));
    return jsonOk({ override });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    if (e instanceof TimetableError) return jsonError(e.message, e.status, e.extra);
    console.error(e);
    return jsonError('Could not save the change', 500);
  }
}

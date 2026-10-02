import { requireAdminApi } from '@/lib/adminGuard';
import { handleRecognise } from '@/lib/gradeMasterApi';
import { gradeStore } from '@/lib/gradeMaster';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Admin only: one-click add of an unrecognised `{ grade, division }` seen from the school app. */
export async function POST(req: Request) {
  return handleRecognise(await req.json().catch(() => null), { guard: requireAdminApi, store: gradeStore });
}

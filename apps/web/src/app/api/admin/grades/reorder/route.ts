import { requireAdminApi } from '@/lib/adminGuard';
import { handleReorder } from '@/lib/gradeMasterApi';
import { gradeStore } from '@/lib/gradeMaster';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Admin only: `{ ids }` = grade ids in display order. */
export async function POST(req: Request) {
  return handleReorder(await req.json().catch(() => null), { guard: requireAdminApi, store: gradeStore });
}

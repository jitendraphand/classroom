import { requireAdminApi } from '@/lib/adminGuard';
import { handleLiveDetail } from '@/lib/adminLiveApi';
import { getLiveClass } from '@/lib/liveClasses';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Admin only: one ongoing class + the names of the students connected now. */
export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handleLiveDetail((await params).code, { guard: requireAdminApi, get: getLiveClass });
}

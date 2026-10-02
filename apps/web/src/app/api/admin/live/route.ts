import { requireAdminApi } from '@/lib/adminGuard';
import { handleListLive } from '@/lib/adminLiveApi';
import { listLiveClasses } from '@/lib/liveClasses';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Admin only: every class that is running right now (see lib/liveClasses.ts). */
export async function GET() {
  return handleListLive({ guard: requireAdminApi, list: listLiveClasses });
}

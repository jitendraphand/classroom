import { requireAdminApi } from '@/lib/adminGuard';
import { handleSync } from '@/lib/gradeMasterApi';
import { gradeStore } from '@/lib/gradeMaster';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Admin only: add grades/divisions used by existing data but missing from the list. */
export async function POST() {
  return handleSync({ guard: requireAdminApi, store: gradeStore });
}

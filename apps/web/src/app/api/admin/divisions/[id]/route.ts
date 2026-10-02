import { requireAdminApi } from '@/lib/adminGuard';
import { handleDeleteDivision, handleUpdateDivision } from '@/lib/gradeMasterApi';
import { gradeStore } from '@/lib/gradeMaster';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const deps = { guard: requireAdminApi, store: gradeStore };
type Ctx = { params: Promise<{ id: string }> };

/** Admin only: rename (`label`) or activate/deactivate (`active`) a division. */
export async function PATCH(req: Request, { params }: Ctx) {
  return handleUpdateDivision((await params).id, await req.json().catch(() => null), deps);
}

/** Admin only: delete; 409 with the usage list when anything still uses it. */
export async function DELETE(_req: Request, { params }: Ctx) {
  return handleDeleteDivision((await params).id, deps);
}

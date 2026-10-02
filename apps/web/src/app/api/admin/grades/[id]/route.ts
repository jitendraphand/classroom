import { requireAdminApi } from '@/lib/adminGuard';
import { handleDeleteGrade, handleUpdateGrade } from '@/lib/gradeMasterApi';
import { gradeStore } from '@/lib/gradeMaster';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const deps = { guard: requireAdminApi, store: gradeStore };
type Ctx = { params: Promise<{ id: string }> };

/** Admin only: rename (`label`), activate/deactivate (`active`), `sortOrder`. */
export async function PATCH(req: Request, { params }: Ctx) {
  return handleUpdateGrade((await params).id, await req.json().catch(() => null), deps);
}

/** Admin only: delete; 409 with the usage list when anything still uses it. */
export async function DELETE(_req: Request, { params }: Ctx) {
  return handleDeleteGrade((await params).id, deps);
}

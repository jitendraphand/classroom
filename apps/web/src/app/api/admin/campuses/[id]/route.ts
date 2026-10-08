import { requireAdminApi } from '@/lib/adminGuard';
import { handleDeleteCampus, handleUpdateCampus } from '@/lib/campusApi';
import { campusStore } from '@/lib/campusMaster';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const deps = { guard: requireAdminApi, store: campusStore };

/** Admin only: `{ label?, active? }` (the code itself only while unused). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleUpdateCampus((await params).id, await req.json().catch(() => null), deps);
}

/** Admin only: delete an unused campus. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleDeleteCampus((await params).id, deps);
}

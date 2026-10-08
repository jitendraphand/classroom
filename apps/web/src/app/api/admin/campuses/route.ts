import { requireAdminApi } from '@/lib/adminGuard';
import { handleCreateCampus, handleListCampuses } from '@/lib/campusApi';
import { campusStore } from '@/lib/campusMaster';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const deps = { guard: requireAdminApi, store: campusStore };

/** Admin only: campuses (incl. inactive) with usage counts, and unrecognised student campuses. */
export async function GET() {
  return handleListCampuses(deps);
}

/** Admin only: add a campus `{ label }`. */
export async function POST(req: Request) {
  return handleCreateCampus(await req.json().catch(() => null), deps);
}

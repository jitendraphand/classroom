import { requireAdminApi } from '@/lib/adminGuard';
import { handleSync } from '@/lib/gradeMasterApi';
import { gradeStore } from '@/lib/gradeMaster';
import { syncCampusesFromData } from '@/lib/campusMaster';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Admin only: add grades/divisions used by existing data but missing from the list. */
export async function POST() {
  const res = await handleSync({ guard: requireAdminApi, store: gradeStore });
  if (!res.ok) return res;
  // Campuses too (the guard above already passed).
  const body = (await res.json()) as { added?: Record<string, number> };
  const campuses = await syncCampusesFromData();
  return Response.json({ ...body, added: { ...(body.added ?? {}), campuses } }, { headers: { 'Cache-Control': 'no-store' } });
}

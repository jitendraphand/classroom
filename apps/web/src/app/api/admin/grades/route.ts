import { requireAdminApi } from '@/lib/adminGuard';
import { handleCreateGrade, handleListGrades } from '@/lib/gradeMasterApi';
import { gradeStore } from '@/lib/gradeMaster';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const deps = { guard: requireAdminApi, store: gradeStore };

/** Admin only: the full master list (incl. inactive), usage counts, unrecognised student entries. */
export async function GET() {
  return handleListGrades(deps);
}

/** Admin only: add a grade `{ label, divisions? }`. */
export async function POST(req: Request) {
  return handleCreateGrade(await req.json().catch(() => null), deps);
}

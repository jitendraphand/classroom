import { requireAdminApi } from '@/lib/adminGuard';
import { handleCreateDivision } from '@/lib/gradeMasterApi';
import { gradeStore } from '@/lib/gradeMaster';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Admin only: add division(s) to a grade `{ name: "A" | "A, B" }`. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleCreateDivision((await params).id, await req.json().catch(() => null), {
    guard: requireAdminApi,
    store: gradeStore,
  });
}

import { requireAdminApi } from '@/lib/adminGuard';
import { adminToday } from '@/lib/adminBoard';
import { jsonOk } from '@/lib/response';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { res } = await requireAdminApi(['viewReports', 'monitorLive', 'schedule']);
  if (res) return res;
  return jsonOk(await adminToday(new URL(req.url)));
}

import { requireAdminApi } from '@/lib/adminGuard';
import { adminSessionFeedback } from '@/lib/adminBoard';
import { jsonError, jsonOk } from '@/lib/response';

export const dynamic = 'force-dynamic';

/** Stars and written comments. Administrators only — teachers have no route here. */
export async function GET(req: Request) {
  const { res } = await requireAdminApi('viewReports');
  if (res) return res;
  const sessionId = new URL(req.url).searchParams.get('sessionId') || '';
  if (!sessionId) return jsonError('sessionId is required');
  return jsonOk({ feedback: await adminSessionFeedback(sessionId) });
}

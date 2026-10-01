import { requireAdminApi } from '@/lib/adminGuard';
import { reportResponse, type ReportKind } from '@/lib/reportRoutes';
import { jsonError } from '@/lib/response';

export const dynamic = 'force-dynamic';

const KINDS = new Set<ReportKind>(['sessions', 'students', 'detail']);

/** GET /api/admin/reports/{sessions|students|detail}?from&to&teacherId&grade&division&subject[&format=csv] */
export async function GET(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const { res } = await requireAdminApi();
  if (res) return res;
  const kind = (await params).kind as ReportKind;
  if (!KINDS.has(kind)) return jsonError('Unknown report', 404);
  return reportResponse(kind, req);
}

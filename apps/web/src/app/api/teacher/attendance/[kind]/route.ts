import { getTeacherSession } from '@/lib/auth';
import { reportResponse, type ReportKind } from '@/lib/reportRoutes';
import { jsonError } from '@/lib/response';

export const dynamic = 'force-dynamic';

const KINDS = new Set<ReportKind>(['sessions', 'students', 'detail']);

/** Same reports as the admin's, always limited to the signed-in teacher's own sessions. */
export async function GET(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);
  const kind = (await params).kind as ReportKind;
  if (!KINDS.has(kind)) return jsonError('Unknown report', 404);
  return reportResponse(kind, req, { teacherId: teacher.id });
}

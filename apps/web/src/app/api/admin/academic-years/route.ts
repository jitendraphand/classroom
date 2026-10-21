import { requireAdminApi } from '@/lib/adminGuard';
import { createAcademicYear, listAcademicYears } from '@/lib/academicYears';
import { jsonError, jsonOk } from '@/lib/response';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { res } = await requireAdminApi(['schedule', 'viewReports', 'manageSchool']);
  if (res) return res;
  const years = await listAcademicYears();
  return jsonOk({ years: years.map((y) => ({ id: y.id, label: y.label, active: y.active })) });
}

export async function POST(req: Request) {
  const { res } = await requireAdminApi('manageSchool');
  if (res) return res;
  const body = (await req.json().catch(() => null)) as { label?: unknown } | null;
  try {
    const row = await createAcademicYear(body?.label);
    return jsonOk({ year: { id: row.id, label: row.label, active: row.active } });
  } catch (e) {
    return jsonError(e instanceof Error ? e.message : 'Could not add the year', 400);
  }
}

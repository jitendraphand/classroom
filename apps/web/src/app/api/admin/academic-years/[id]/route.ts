import { requireAdminApi } from '@/lib/adminGuard';
import { deleteAcademicYear, setAcademicYearActive } from '@/lib/academicYears';
import { jsonError, jsonOk } from '@/lib/response';

export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { res } = await requireAdminApi('manageSchool');
  if (res) return res;
  const body = (await req.json().catch(() => null)) as { active?: unknown } | null;
  if (typeof body?.active !== 'boolean') return jsonError('active must be true or false');
  const row = await setAcademicYearActive((await params).id, body.active);
  if (!row) return jsonError('Academic year not found', 404);
  return jsonOk({ year: { id: row.id, label: row.label, active: row.active } });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { res } = await requireAdminApi('manageSchool');
  if (res) return res;
  const out = await deleteAcademicYear((await params).id);
  if (!out.ok) return jsonError(out.error, 409);
  return jsonOk({ ok: true });
}

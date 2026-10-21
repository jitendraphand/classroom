import { requireAdminApi } from '@/lib/adminGuard';
import { academicYearForDate, isAcademicYearLabel } from '@/lib/academicYear';
import { computeRankWeek } from '@/lib/rankingService';
import { jsonError, jsonOk } from '@/lib/response';
import { appTimeZone } from '@/lib/schoolConfig';
import { localDateOf, weekdayOf } from '@/lib/schedule';
import { weekStartMonday } from '@/lib/ranking';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const { res } = await requireAdminApi('viewReports');
  if (res) return res;
  const body = (await req.json().catch(() => null)) as { academicYear?: unknown } | null;
  const tz = appTimeZone();
  const today = localDateOf(new Date(), tz);
  const year = isAcademicYearLabel(body?.academicYear) ? String(body?.academicYear) : academicYearForDate(today);
  if (!isAcademicYearLabel(year)) return jsonError('Pick an academic year');
  const week = weekStartMonday(today, weekdayOf(today));
  const rows = await computeRankWeek(year, week);
  return jsonOk({ academicYear: year, weekStart: week, teachers: rows.length, eligible: rows.filter((r) => r.eligible).length });
}

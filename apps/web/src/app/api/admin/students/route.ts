import { prisma } from '@/lib/db';
import { requireAdminApi } from '@/lib/adminGuard';
import { normalizeDivision, normalizeGrade } from '@/lib/grades';
import { jsonOk } from '@/lib/response';

export const dynamic = 'force-dynamic';

/** Known students (first signed join or roster import), filterable. */
export async function GET(req: Request) {
  const { res } = await requireAdminApi();
  if (res) return res;
  const url = new URL(req.url);
  const grade = url.searchParams.get('grade');
  const division = url.searchParams.get('division');
  const q = url.searchParams.get('q')?.trim();
  const where = {
    ...(grade ? { grade: normalizeGrade(grade) } : {}),
    ...(division ? { division: normalizeDivision(division) } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' as const } },
            { externalId: { contains: q } },
            { rollNumber: { equals: q } },
          ],
        }
      : {}),
  };
  const [total, students, groups] = await Promise.all([
    prisma.student.count({ where }),
    prisma.student.findMany({
      where,
      orderBy: [{ grade: 'asc' }, { division: 'asc' }, { rollNumber: 'asc' }, { name: 'asc' }],
      take: 500,
      select: { id: true, externalId: true, name: true, grade: true, division: true, rollNumber: true, source: true, lastSeenAt: true },
    }),
    prisma.student.groupBy({ by: ['grade', 'division'], _count: { _all: true }, orderBy: [{ grade: 'asc' }, { division: 'asc' }] }),
  ]);
  return jsonOk({
    total,
    students,
    groups: groups.map((g) => ({ grade: g.grade, division: g.division, count: g._count._all })),
  });
}

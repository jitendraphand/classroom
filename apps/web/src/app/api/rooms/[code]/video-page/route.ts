import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { moveVideoPage } from '@/lib/sample';

export const dynamic = 'force-dynamic';

/**
 * Teacher moves the student-video panel to another page (lib/videoPages):
 * `{ delta: 1 }` next, `{ delta: -1 }` previous (both wrap), or `{ page }`
 * (0-based, clamped). Only the new page's students then publish camera
 * video; the old page's students stop. Answers the new page summary.
 */
const schema = z
  .object({
    delta: z.number().int().min(-50).max(50).optional(),
    page: z.number().int().min(0).max(10_000).optional(),
  })
  .refine((b) => b.delta !== undefined || b.page !== undefined, 'delta or page required');

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);
  const code = (await params).code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code }, select: { teacherId: true, status: true } });
  if (!room || room.teacherId !== teacher.id) return jsonError('Room not found', 404);
  if (room.status === 'ENDED') return jsonError('Class ended', 410, { ended: true });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.errors[0]?.message || 'Invalid input');
  const r = await moveVideoPage(code, parsed.data);
  return jsonOk({
    page: 'page' in r ? r.page : 0,
    pages: 'pages' in r ? r.pages : 1,
    total: 'total' in r ? r.total : 0,
    pageSize: 'pageSize' in r ? r.pageSize : 0,
    order: 'order' in r ? r.order : [],
  });
}

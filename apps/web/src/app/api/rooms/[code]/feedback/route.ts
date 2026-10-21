import { prisma } from '@/lib/db';
import { getPupil } from '@/lib/auth';
import { feedbackProblem, normalizeFeedbackComment } from '@/lib/feedbackText';
import { jsonError, jsonOk } from '@/lib/response';

export const dynamic = 'force-dynamic';

/**
 * One rating per student per class. The pupil cookie survives leaving the room
 * (only the participant cookie is cleared), so this works after the class ends.
 */
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const pupil = await getPupil();
  if (!pupil) return jsonError('Sign in from the school app to send feedback', 403);

  const code = (await params).code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code }, select: { classSessionId: true } });
  if (!room?.classSessionId) return jsonError('This class cannot take feedback', 404);

  const attendance = await prisma.attendanceRecord.findFirst({
    where: { classSessionId: room.classSessionId, studentId: pupil.id, admittedAt: { not: null } },
    select: { id: true },
  });
  if (!attendance) return jsonError('Only students who attended can send feedback', 403);

  const body = (await req.json().catch(() => null)) as { stars?: unknown; comment?: unknown; skip?: unknown } | null;
  if (body?.skip === true) return jsonOk({ ok: true, skipped: true });

  const problem = feedbackProblem(body?.stars, body?.comment);
  if (problem) return jsonError(problem, 400);

  const existing = await prisma.classFeedback.findUnique({
    where: { classSessionId_studentId: { classSessionId: room.classSessionId, studentId: pupil.id } },
    select: { id: true },
  });
  if (existing) return jsonError('You already sent feedback for this class', 409);

  await prisma.classFeedback.create({
    data: {
      classSessionId: room.classSessionId,
      studentId: pupil.id,
      stars: body!.stars as number,
      comment: normalizeFeedbackComment(body?.comment),
    },
  });
  return jsonOk({ ok: true });
}

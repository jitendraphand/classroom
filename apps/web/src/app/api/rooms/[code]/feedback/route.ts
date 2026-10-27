import { prisma } from '@/lib/db';
import { getPupil } from '@/lib/auth';
import { feedbackProblem, normalizeFeedbackComment, presentAtEnd } from '@/lib/feedbackText';
import { jsonError, jsonOk } from '@/lib/response';

export const dynamic = 'force-dynamic';

/**
 * One rating per student per class. The pupil cookie survives leaving the room
 * (only the participant cookie is cleared), so this works after the class ends.
 */
async function eligibility(code: string) {
  const pupil = await getPupil();
  if (!pupil) return { error: jsonError('Sign in from the school app to send feedback', 403) };
  const room = await prisma.room.findUnique({
    where: { code },
    select: { classSessionId: true, status: true, endedAt: true },
  });
  if (!room?.classSessionId) return { error: jsonError('This class cannot take feedback', 404) };
  const attendance = await prisma.attendanceRecord.findFirst({
    where: { classSessionId: room.classSessionId, studentId: pupil.id, admittedAt: { not: null } },
    select: { openSids: true, connectedSince: true, leftAt: true },
  });
  if (!attendance) return { error: jsonError('Only students who attended can send feedback', 403) };
  const cs = await prisma.classSession.findUnique({ where: { id: room.classSessionId }, select: { endedAt: true } });
  const endedAt = cs?.endedAt ?? room.endedAt ?? null;
  if (room.status !== 'ENDED' && !endedAt) {
    return { error: jsonError('Feedback opens when the teacher ends the class', 409) };
  }
  if (!presentAtEnd(attendance, endedAt)) {
    return { error: jsonError('Feedback is for students who were in the class when it ended', 403, { leftEarly: true }) };
  }
  return { pupil, classSessionId: room.classSessionId };
}

/** Whether this student gets the form (in class when it ended, not sent yet). */
export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const r = await eligibility((await params).code.toUpperCase());
  if ('error' in r) return jsonOk({ eligible: false });
  const existing = await prisma.classFeedback.findUnique({
    where: { classSessionId_studentId: { classSessionId: r.classSessionId, studentId: r.pupil.id } },
    select: { id: true },
  });
  return jsonOk({ eligible: !existing });
}

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  const r = await eligibility(code);
  if ('error' in r) return r.error;
  const { pupil } = r;
  const room = { classSessionId: r.classSessionId };

  const body = (await req.json().catch(() => null)) as { stars?: unknown; comment?: unknown; skip?: unknown } | null;
  if (body?.skip === true) return jsonOk({ ok: true, skipped: true });

  const problem = feedbackProblem(body?.stars, body?.comment);
  if (problem) return jsonError(problem, 400);

  const existing = await prisma.classFeedback.findUnique({
    where: { classSessionId_studentId: { classSessionId: room.classSessionId, studentId: pupil.id } },
    select: { id: true },
  });
  if (existing) return jsonError('You already sent feedback for this class', 409);

  try {
    await prisma.classFeedback.create({
      data: {
        classSessionId: room.classSessionId,
        studentId: pupil.id,
        stars: body!.stars as number,
        comment: normalizeFeedbackComment(body?.comment),
      },
    });
  } catch (e) {
    // A double tap sent two requests: the unique (session, student) row exists.
    if ((e as { code?: string }).code === 'P2002') return jsonError('You already sent feedback for this class', 409);
    throw e;
  }
  return jsonOk({ ok: true });
}

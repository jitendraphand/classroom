import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getPupil, setStudentCookie, setActAsStudent } from '@/lib/auth';
import { manualStudentJoinAllowed } from '@/lib/schoolConfig';
import { arriveAtSession, studentMayEnterRoom } from '@/lib/studentService';
import { generateIdentity, generateSessionToken } from '@/lib/codes';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureRedis, keys } from '@/lib/redis';
import { admitWaiting } from '@/lib/admission';
import { shouldAutoAdmit } from '@/lib/admissionLogic';

const schema = z.object({
  // Ignored for school-app students (their name comes from the signed token).
  displayName: z.string().trim().max(60).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const code = (await params).code.toUpperCase();
    const body = schema.parse(await req.json());
    const room = await prisma.room.findUnique({ where: { code } });
    if (!room) return jsonError('Room not found', 404);
    if (room.status === 'ENDED') return jsonError('This class has ended', 410);

    // A school-app student can only ever enter their own grade/division's class,
    // whatever meeting code they type.
    const pupil = await getPupil();
    if (pupil) {
      const { ok, cs } = await studentMayEnterRoom(pupil, room);
      if (!ok || !cs) return jsonError('This class is not for your grade and division.', 403);
      const { participant } = await arriveAtSession(pupil, cs);
      if (!participant) return jsonError('This class is not open yet.', 409);
      return jsonOk({
        participantId: participant.id,
        displayName: participant.displayName,
        status: participant.status,
        roomCode: room.code,
        roomName: room.name,
        waitingUrl: `/join/${room.code}?waiting=1&as=student`,
      });
    }

    // Students join through the signed school-app link (GET /join?t=…). The
    // code + name path is for development/testing only.
    if (!manualStudentJoinAllowed()) {
      return jsonError('Students join from the school app. Open the class there.', 403, { manualJoinDisabled: true });
    }

    if (!body.displayName) return jsonError('Enter your name');
    const sessionToken = generateSessionToken();
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);

    const participant = await prisma.participant.create({
      data: {
        roomId: room.id,
        displayName: body.displayName,
        role: 'STUDENT',
        status: 'WAITING',
        livekitIdentity: generateIdentity('student', id),
        sessionToken,
        // Students join muted; the teacher unmutes one by one or with Allow unmute.
        mutedByTeacher: true,
      },
    });

    const redis = await ensureRedis();
    await redis.sadd(keys.waiting(code), participant.id);
    // Waiting room switched off by the teacher: straight into the class.
    let status: string = participant.status;
    if (shouldAutoAdmit(room, participant)) {
      await admitWaiting(room, { ids: [participant.id] });
      status = 'ADMITTED';
    }

    await setStudentCookie(sessionToken);
    // Prefer student identity for this tab even if a teacher cookie exists
    await setActAsStudent();

    return jsonOk({
      participantId: participant.id,
      displayName: participant.displayName,
      status,
      roomCode: room.code,
      roomName: room.name,
      waitingUrl: `/join/${room.code}?waiting=1&as=student`,
    });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    console.error(e);
    return jsonError('Failed to join', 500);
  }
}

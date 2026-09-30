import { z } from 'zod';
import { prisma } from '@/lib/db';
import { setStudentCookie, setActAsStudent } from '@/lib/auth';
import { generateIdentity, generateSessionToken } from '@/lib/codes';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureRedis, keys } from '@/lib/redis';

const schema = z.object({
  displayName: z.string().min(1).max(60),
});

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const code = (await params).code.toUpperCase();
    const body = schema.parse(await req.json());
    const room = await prisma.room.findUnique({ where: { code } });
    if (!room) return jsonError('Room not found', 404);
    if (room.status === 'ENDED') return jsonError('This class has ended', 410);

    const sessionToken = generateSessionToken();
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);

    const participant = await prisma.participant.create({
      data: {
        roomId: room.id,
        displayName: body.displayName.trim(),
        role: 'STUDENT',
        status: 'WAITING',
        livekitIdentity: generateIdentity('student', id),
        sessionToken,
      },
    });

    const redis = await ensureRedis();
    await redis.sadd(keys.waiting(code), participant.id);

    await setStudentCookie(sessionToken);
    // Prefer student identity for this tab even if a teacher cookie exists
    await setActAsStudent();

    return jsonOk({
      participantId: participant.id,
      displayName: participant.displayName,
      status: participant.status,
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

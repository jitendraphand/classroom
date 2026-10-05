import { z } from 'zod';
import { nudgeRoomState, pushMuteState } from '@/lib/roomNudge';
import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureRedis, keys } from '@/lib/redis';
import { setManyParticipantMics, setParticipantMicAllowed } from '@/lib/livekit';
import { clearPinnedSpeakers, getVisibleSample, unpinSpeaker } from '@/lib/sample';

const schema = z.union([
  z.object({
    all: z.literal(true),
    muted: z.boolean(),
  }),
  z.object({
    participantId: z.string(),
    muted: z.boolean(),
  }),
]);

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);

  const code = (await params).code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.teacherId !== teacher.id) return jsonError('Room not found', 404);
  if (room.status === 'ENDED') return jsonError('Class ended', 410);

  try {
    const body = schema.parse(await req.json());
    const redis = await ensureRedis();

    if ('all' in body) {
      const students = await prisma.participant.findMany({
        where: { roomId: room.id, role: 'STUDENT', status: 'ADMITTED' },
        select: { id: true, livekitIdentity: true },
      });
      const ids = students.map((s) => s.id);
      const identities = students.map((s) => s.livekitIdentity);

      await prisma.participant.updateMany({
        where: { roomId: room.id, role: 'STUDENT', status: 'ADMITTED' },
        data: { mutedByTeacher: body.muted },
      });

      if (body.muted) {
        if (ids.length) {
          await redis.del(keys.muted(code));
          await redis.sadd(keys.muted(code), ...ids);
        } else {
          await redis.del(keys.muted(code));
        }
      } else {
        await redis.del(keys.muted(code));
      }

      // Force LiveKit mic off / restore so clients cannot self-unmute. Camera
      // permission must follow current sample membership, otherwise this would
      // re-grant camera to students outside the visible sample.
      const { visible } = await getVisibleSample(code);
      const inSample = new Set(visible);
      void setManyParticipantMics(
        code,
        identities,
        !body.muted,
        (identity) => inSample.has(identity)
      );

      // Sticky speak-pins last until mute — clear all when muting everyone
      if (body.muted) {
        await clearPinnedSpeakers(code);
      }

      pushMuteState(room.code, room.sessionId, identities, body.muted);
      nudgeRoomState(room.code, 'all');
      return jsonOk({ ok: true, all: true, muted: body.muted, count: ids.length });
    }

    const participant = await prisma.participant.findFirst({
      where: { id: body.participantId, roomId: room.id, role: 'STUDENT' },
    });
    if (!participant) return jsonError('Participant not found', 404);

    await prisma.participant.update({
      where: { id: participant.id },
      data: { mutedByTeacher: body.muted },
    });

    if (body.muted) await redis.sadd(keys.muted(code), participant.id);
    else await redis.srem(keys.muted(code), participant.id);

    const { visible } = await getVisibleSample(code);
    void setParticipantMicAllowed(
      code,
      participant.livekitIdentity,
      !body.muted,
      visible.includes(participant.livekitIdentity)
    );

    // Sticky speak-pin: drop when teacher mutes this student
    if (body.muted) {
      await unpinSpeaker(code, participant.livekitIdentity);
    }

    pushMuteState(room.code, room.sessionId, [participant.livekitIdentity], body.muted);
    nudgeRoomState(room.code, 'all');
    return jsonOk({ ok: true, muted: body.muted });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    console.error(e);
    return jsonError('Mute failed', 500);
  }
}

import { z } from 'zod';
import { nudgeRoomState, pushMuteState } from '@/lib/roomNudge';
import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureRedis, keys } from '@/lib/redis';
import { setManyParticipantMics } from '@/lib/livekit';
import { clearPinnedSpeakers, getVisibleSample } from '@/lib/sample';
import { getSchoolSettings } from '@/lib/schoolSettings';
import { updateMicBook } from '@/lib/micBook';
import { isStudentCamOn } from '@/lib/studentCamera';
import { NO_UNMUTE_ALL, teacherUnmuteBlock } from '@/lib/speakingRules';
import { setStudentMuted } from '@/lib/teacherMute';

/**
 * Teacher mutes everyone ({all:true, muted:true}), or mutes / unmutes one
 * student. There is no "allow all to unmute" (Nov 25): the teacher unmutes
 * students one by one, and only students whose camera is on (lib/speakingRules).
 */
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

/** Swap the room's muted set in one transaction (readers never see it empty mid-update). */
async function replaceMutedSet(redis: Awaited<ReturnType<typeof ensureRedis>>, code: string, ids: string[]) {
  const m = redis.multi().del(keys.muted(code));
  if (ids.length) m.sadd(keys.muted(code), ...ids);
  await m.exec();
}

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);

  const code = (await params).code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.teacherId !== teacher.id) return jsonError('Room not found', 404);
  if (room.status === 'ENDED') return jsonError('Class ended', 410);

  try {
    const body = schema.parse(await req.json());

    if ('all' in body) {
      if (!body.muted) return jsonError(NO_UNMUTE_ALL, 400);
      const redis = await ensureRedis();
      const { maxOpenStudentMics: micLimit } = await getSchoolSettings();
      const students = await prisma.participant.findMany({
        where: { roomId: room.id, role: 'STUDENT', status: 'ADMITTED' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, livekitIdentity: true },
      });
      if (micLimit > 0) await updateMicBook(code, () => ({ next: { open: [], queue: [] } }));
      await prisma.participant.updateMany({
        where: { roomId: room.id, role: 'STUDENT', status: 'ADMITTED' },
        data: { mutedByTeacher: true },
      });
      const ids = students.map((s) => s.id);
      const identities = students.map((s) => s.livekitIdentity);
      await replaceMutedSet(redis, code, ids);
      // Force LiveKit mic off so clients cannot self-unmute. Camera permission
      // follows sample membership (no speaking students remain).
      const { visible } = await getVisibleSample(code);
      const inSample = new Set(visible);
      await setManyParticipantMics(code, identities, false, (identity) => inSample.has(identity));
      await clearPinnedSpeakers(code);
      pushMuteState(room.code, room.sessionId, identities, true);
      nudgeRoomState(room.code, 'all');
      return jsonOk({ ok: true, all: true, muted: true, count: ids.length, waiting: 0 });
    }

    const participant = await prisma.participant.findFirst({
      where: { id: body.participantId, roomId: room.id, role: 'STUDENT' },
      select: { id: true, livekitIdentity: true },
    });
    if (!participant) return jsonError('Participant not found', 404);

    if (!body.muted) {
      const block = teacherUnmuteBlock({ camOn: await isStudentCamOn(code, participant.livekitIdentity) });
      if (block) return jsonError(block, 409, { reason: 'camera_off' });
    }

    const res = await setStudentMuted(room, participant, body.muted);
    return jsonOk({ ok: true, muted: res.muted, waiting: res.waiting });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    console.error(e);
    return jsonError('Mute failed', 500);
  }
}

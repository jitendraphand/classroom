import { z } from 'zod';
import { nudgeRoomState, pushMuteState } from '@/lib/roomNudge';
import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureRedis, keys } from '@/lib/redis';
import { setManyParticipantMics, setParticipantMicAllowed } from '@/lib/livekit';
import { clearPinnedSpeakers, getVisibleSample, unpinSpeaker } from '@/lib/sample';
import { getSchoolSettings } from '@/lib/schoolSettings';
import { readMicBook, writeMicBook } from '@/lib/micBook';
import { teacherSetMic } from '@/lib/micSlots';

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
    const { maxOpenStudentMics: micLimit } = await getSchoolSettings();

    if ('all' in body) {
      const students = await prisma.participant.findMany({
        where: { roomId: room.id, role: 'STUDENT', status: 'ADMITTED' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, livekitIdentity: true },
      });
      if (micLimit > 0) {
        const { visible } = await getVisibleSample(code);
        const inSample = new Set(visible);
        if (body.muted) {
          await writeMicBook(code, { open: [], queue: [] });
          await prisma.participant.updateMany({
            where: { roomId: room.id, role: 'STUDENT', status: 'ADMITTED' },
            data: { mutedByTeacher: true },
          });
          const ids = students.map((s) => s.id);
          if (ids.length) {
            await redis.del(keys.muted(code));
            await redis.sadd(keys.muted(code), ...ids);
          } else await redis.del(keys.muted(code));
          void setManyParticipantMics(code, students.map((s) => s.livekitIdentity), false, (identity) => inSample.has(identity));
          await clearPinnedSpeakers(code);
          pushMuteState(room.code, room.sessionId, students.map((s) => s.livekitIdentity), true);
          nudgeRoomState(room.code, 'all');
          return jsonOk({ ok: true, all: true, muted: true, count: ids.length, waiting: 0 });
        }
        let book = { open: [] as string[], queue: [] as { id: string; source: 'teacher' | 'student' }[] };
        const openIds: string[] = [];
        for (const s of students) {
          const next = teacherSetMic(book, s.id, false, micLimit);
          book = next;
          if (next.granted) openIds.push(s.id);
        }
        await writeMicBook(code, book);
        const waiting = students.filter((s) => !openIds.includes(s.id)).map((s) => s.id);
        if (openIds.length) {
          await prisma.participant.updateMany({ where: { id: { in: openIds } }, data: { mutedByTeacher: false } });
        }
        if (waiting.length) {
          await prisma.participant.updateMany({ where: { id: { in: waiting } }, data: { mutedByTeacher: true } });
        }
        if (waiting.length) {
          await redis.del(keys.muted(code));
          await redis.sadd(keys.muted(code), ...waiting);
        } else await redis.del(keys.muted(code));
        const openSet = new Set(openIds);
        for (const s of students) {
          void setParticipantMicAllowed(code, s.livekitIdentity, openSet.has(s.id), inSample.has(s.livekitIdentity));
        }
        pushMuteState(room.code, room.sessionId, students.filter((s) => openSet.has(s.id)).map((s) => s.livekitIdentity), false);
        pushMuteState(room.code, room.sessionId, students.filter((s) => !openSet.has(s.id)).map((s) => s.livekitIdentity), true);
        nudgeRoomState(room.code, 'all');
        return jsonOk({ ok: true, all: true, muted: false, count: openIds.length, waiting: waiting.length });
      }
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

    if (micLimit > 0) {
      const book = await readMicBook(code);
      const next = teacherSetMic(book, participant.id, body.muted, micLimit);
      await writeMicBook(code, next);
      const muted = body.muted || !next.granted;
      await prisma.participant.update({ where: { id: participant.id }, data: { mutedByTeacher: muted } });
      if (muted) await redis.sadd(keys.muted(code), participant.id);
      else await redis.srem(keys.muted(code), participant.id);
      const { visible } = await getVisibleSample(code);
      void setParticipantMicAllowed(code, participant.livekitIdentity, !muted, visible.includes(participant.livekitIdentity));
      if (muted) await unpinSpeaker(code, participant.livekitIdentity);
      pushMuteState(room.code, room.sessionId, [participant.livekitIdentity], muted);
      const promoted = 'promoted' in next ? (next as { promoted?: string | null }).promoted : null;
      if (promoted) {
        const nextStudent = await prisma.participant.findFirst({ where: { id: promoted, roomId: room.id, role: 'STUDENT' } });
        if (nextStudent) {
          await prisma.participant.update({ where: { id: nextStudent.id }, data: { mutedByTeacher: false } });
          await redis.srem(keys.muted(code), nextStudent.id);
          void setParticipantMicAllowed(code, nextStudent.livekitIdentity, true, visible.includes(nextStudent.livekitIdentity));
          pushMuteState(room.code, room.sessionId, [nextStudent.livekitIdentity], false);
        }
      }
      // Item 14: one student's mute only refreshes the teacher + affected students, not 2,000 clients.
      nudgeRoomState(room.code, { participantIds: promoted ? [participant.id, promoted] : [participant.id] });
      return jsonOk({ ok: true, muted, waiting: next.waiting });
    }

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
    nudgeRoomState(room.code, { participantIds: [participant.id] });
    return jsonOk({ ok: true, muted: body.muted });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    console.error(e);
    return jsonError('Mute failed', 500);
  }
}

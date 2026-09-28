import { prisma } from '@/lib/db';
import { generateRoomCode, generateIdentity, generateSessionToken } from '@/lib/codes';
import { ensureRedis, keys } from '@/lib/redis';
import { clampMaxVisible } from '@/lib/sample';

/** Allocate a unique permanent class code not used by any teacher or room. */
export async function allocateUniqueCode(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = generateRoomCode();
    const [t, r] = await Promise.all([
      prisma.teacher.findUnique({ where: { permanentCode: code } }),
      prisma.room.findUnique({ where: { code } }),
    ]);
    if (!t && !r) return code;
  }
  // Extremely unlikely fallback
  return generateRoomCode() + generateRoomCode().slice(0, 2);
}

/** Ensure teacher has a permanentCode (lazy backfill for pre-migration rows). */
export async function ensureTeacherPermanentCode(teacherId: string): Promise<string> {
  const teacher = await prisma.teacher.findUnique({ where: { id: teacherId } });
  if (!teacher) throw new Error('Teacher not found');
  if (teacher.permanentCode) return teacher.permanentCode;

  // Prefer an existing non-ended room code, else newest room, else allocate
  const preferred =
    (await prisma.room.findFirst({
      where: { teacherId, status: { not: 'ENDED' } },
      orderBy: { createdAt: 'desc' },
    })) ||
    (await prisma.room.findFirst({
      where: { teacherId },
      orderBy: { createdAt: 'desc' },
    }));

  let code = preferred?.code;
  if (!code) {
    code = await allocateUniqueCode();
  } else {
    const clash = await prisma.teacher.findFirst({
      where: { permanentCode: code, NOT: { id: teacherId } },
    });
    if (clash) code = await allocateUniqueCode();
  }

  await prisma.teacher.update({
    where: { id: teacherId },
    data: { permanentCode: code },
  });
  return code;
}

async function clearRoomRedis(code: string) {
  const redis = await ensureRedis();
  await redis.del(
    keys.waiting(code),
    keys.admitted(code),
    keys.visible(code),
    keys.muted(code),
    keys.rotation(code),
    keys.whiteboard(code),
    keys.hands(code),
    keys.stage(code),
    keys.wbWrite(code),
    keys.annotate(code),
    keys.pinnedSpeakers(code)
  );
}

/**
 * Start or reopen the teacher's permanent classroom (same code every time).
 * Creates the room if missing; reactivates if ENDED; returns existing if live/waiting.
 */
export async function startOrReopenTeacherRoom(
  teacher: { id: string; name: string; permanentCode?: string | null },
  opts: { name?: string; maxVisibleVideos?: number }
) {
  const code = teacher.permanentCode || (await ensureTeacherPermanentCode(teacher.id));
  const teacherIdentity = generateIdentity('teacher', `${teacher.id}_${code}`);

  let room = await prisma.room.findUnique({ where: { code } });

  if (room && room.teacherId !== teacher.id) {
    throw new Error('CODE_CONFLICT');
  }

  if (!room) {
    room = await prisma.room.create({
      data: {
        code,
        name: (opts.name || 'Live Class').trim(),
        teacherId: teacher.id,
        maxVisibleVideos: clampMaxVisible(opts.maxVisibleVideos ?? 6),
        status: 'WAITING',
        participants: {
          create: {
            displayName: teacher.name,
            role: 'TEACHER',
            status: 'ADMITTED',
            livekitIdentity: teacherIdentity,
            sessionToken: generateSessionToken(),
          },
        },
      },
    });
    return room;
  }

  if (room.status === 'ENDED') {
    await clearRoomRedis(code);
    room = await prisma.room.update({
      where: { id: room.id },
      data: {
        status: 'WAITING',
        endedAt: null,
        name: opts.name?.trim() || room.name,
        maxVisibleVideos: clampMaxVisible(opts.maxVisibleVideos ?? room.maxVisibleVideos),
      },
    });

    const existingTeacher = await prisma.participant.findFirst({
      where: { roomId: room.id, role: 'TEACHER' },
      orderBy: { createdAt: 'asc' },
    });

    if (existingTeacher) {
      await prisma.participant.update({
        where: { id: existingTeacher.id },
        data: {
          status: 'ADMITTED',
          leftAt: null,
          displayName: teacher.name,
          sessionToken: generateSessionToken(),
          mutedByTeacher: false,
          // Keep stable LiveKit identity across sessions for this permanent room
          livekitIdentity: existingTeacher.livekitIdentity || teacherIdentity,
        },
      });
    } else {
      await prisma.participant.create({
        data: {
          roomId: room.id,
          displayName: teacher.name,
          role: 'TEACHER',
          status: 'ADMITTED',
          livekitIdentity: teacherIdentity,
          sessionToken: generateSessionToken(),
        },
      });
    }

    // Mark leftover students as LEFT so waiting room starts clean
    await prisma.participant.updateMany({
      where: { roomId: room.id, role: 'STUDENT', status: { not: 'LEFT' } },
      data: { status: 'LEFT', leftAt: new Date() },
    });

    // Chat history is per-session. A teacher's permanent room row is reused
    // forever, so without this the NEXT class would start by showing the
    // previous class's conversation — including teacher DMs addressed to
    // individual students by name. Matches the documented behaviour that chat is
    // cleared when a class ends.
    await prisma.message.deleteMany({ where: { roomId: room.id } });

    return room;
  }

  // Already WAITING or LIVE — optionally refresh name / max visible (hard-cap at 6)
  const nextMax =
    opts.maxVisibleVideos != null
      ? clampMaxVisible(opts.maxVisibleVideos)
      : clampMaxVisible(room.maxVisibleVideos);
  if (opts.name || opts.maxVisibleVideos != null || nextMax !== room.maxVisibleVideos) {
    room = await prisma.room.update({
      where: { id: room.id },
      data: {
        ...(opts.name ? { name: opts.name.trim() } : {}),
        maxVisibleVideos: nextMax,
      },
    });
  }

  // Ensure teacher participant is admitted
  const teacherPart = await prisma.participant.findFirst({
    where: { roomId: room.id, role: 'TEACHER' },
    orderBy: { createdAt: 'asc' },
  });
  if (teacherPart && teacherPart.status !== 'ADMITTED') {
    await prisma.participant.update({
      where: { id: teacherPart.id },
      data: { status: 'ADMITTED', leftAt: null, sessionToken: generateSessionToken() },
    });
  } else if (!teacherPart) {
    await prisma.participant.create({
      data: {
        roomId: room.id,
        displayName: teacher.name,
        role: 'TEACHER',
        status: 'ADMITTED',
        livekitIdentity: teacherIdentity,
        sessionToken: generateSessionToken(),
      },
    });
  }

  return room;
}

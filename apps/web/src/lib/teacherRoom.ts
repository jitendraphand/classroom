import { releaseRoom } from './mediaServers';
import { roomServiceFor } from './livekit';
import { waitingRoomDefaultFor } from './waitingRoomPref';
import { prisma } from '@/lib/db';
import { generateRoomCode, generateIdentity, generateSessionToken } from '@/lib/codes';
import { ensureRedis, keys, legacyKeys } from '@/lib/redis';
import { clampMaxVisible } from '@/lib/sample';
import { forgetLivekitRoomName, livekitRoomName, sendRoomData } from '@/lib/livekit';
import { STATE_TOPIC } from '@/lib/pollPolicy';

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

function newSessionId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

export async function clearRoomRedis(code: string) {
  const redis = await ensureRedis();
  await redis.del(
    keys.waiting(code),
    keys.admitted(code),
    keys.visible(code),
    keys.muted(code),
    keys.rotation(code),
    keys.hands(code),
    keys.handsAt(code),
    keys.focus(code),
    keys.drawRequests(code),
    keys.drawHolder(code),
    keys.drawHolders(code),
    `room:${code}:wb`,
    keys.studentLive(code),
    keys.drawStrokes(code),
    keys.drawOrder(code),
    keys.stage(code),
    keys.desktopInk(code),
    keys.pinnedSpeakers(code),
    keys.teacherPresent(code),
    keys.micBook(code),
    keys.spotlight(code),
    ...legacyKeys(code)
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
        sessionId: newSessionId(),
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
        // New LiveKit room name for the new session: tokens minted for the last
        // class (same permanent code) no longer name this room.
        sessionId: newSessionId(),
        // Every class starts with the waiting room on.
        waitingRoomOn: await waitingRoomDefaultFor(teacher.id),
        name: opts.name?.trim() || room.name,
        maxVisibleVideos: clampMaxVisible(opts.maxVisibleVideos ?? room.maxVisibleVideos),
      },
    });
    // Relays (strokes, nudges) must name the new LiveKit room at once on this worker.
    forgetLivekitRoomName(code);

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

/**
 * End the class running in a room: room ENDED, everyone LEFT, Redis state
 * cleared, LiveKit room deleted and the room's current ClassSession closed.
 * Shared by POST /end and by switching the permanent room to another class.
 */
export async function endRoom(room: { id: string; code: string; sessionId: string; classSessionId?: string | null }) {
  const now = new Date();
  await prisma.room.update({
    where: { id: room.id },
    data: { status: 'ENDED', endedAt: now },
  });
  // Tell everyone the class ended BEFORE the room is deleted. Under load,
  // deleteRoom is often reported as PARTICIPANT_REMOVED ("you were removed").
  const rn = livekitRoomName(room.code, room.sessionId);
  await sendRoomData(rn, { v: 1, type: 'class-ended' }, { topic: STATE_TOPIC });
  await prisma.participant.updateMany({
    where: { roomId: room.id, status: { not: 'LEFT' } },
    data: { status: 'LEFT', leftAt: now },
  });
  if (room.classSessionId) {
    await onClassSessionEnded(room.classSessionId, now);
  }
  await clearRoomRedis(room.code);
  try {
    await (await roomServiceFor(rn)).deleteRoom(rn);
    await releaseRoom(rn);
  } catch (e) {
    console.warn('LiveKit deleteRoom', e instanceof Error ? e.message : e);
  }
}

/** Close a class session (idempotent: keeps the first end time unless reopened). */
export async function onClassSessionEnded(classSessionId: string, at: Date) {
  await prisma.classSession.updateMany({
    where: { id: classSessionId, endedAt: null },
    data: { endedAt: at },
  });
  // Write queued joins/leaves first so a student who left before the end is
  // not closed "at the end" (feedback goes only to students present then).
  const { flushAttendanceQueue } = await import('./attendanceQueue');
  await flushAttendanceQueue({ wait: true }).catch((e) => console.error('attendance flush at end', e));
  const { closeSessionAttendance } = await import('./attendanceService');
  await closeSessionAttendance(classSessionId, at);
}

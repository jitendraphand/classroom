import { z } from 'zod';
import { prisma } from '@/lib/db';
import { resolveRoomAccess } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';

export const dynamic = 'force-dynamic';

const MAX_BODY = 2000;

type AccessCtx = {
  room: { id: string; code: string; status: string; teacherId: string };
  isTeacher: boolean;
  participantId: string | null;
  myRole: 'TEACHER' | 'STUDENT' | null;
  admitted: boolean;
};

async function resolveAccess(req: Request, code: string): Promise<AccessCtx | null> {
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room) return null;

  const url = new URL(req.url);
  const forceStudent =
    url.searchParams.get('as') === 'student' ||
    req.headers.get('x-classroom-as') === 'student';
  const access = await resolveRoomAccess(room, { forceStudent });

  if (access.isTeacher) {
    const teacherParticipant = await prisma.participant.findFirst({
      where: { roomId: room.id, role: 'TEACHER', status: 'ADMITTED' },
    });
    return {
      room,
      isTeacher: true,
      participantId: teacherParticipant?.id ?? null,
      myRole: 'TEACHER',
      admitted: true,
    };
  }

  if (
    access.mode === 'student' &&
    access.student &&
    access.student.roomId === room.id &&
    access.student.status !== 'LEFT'
  ) {
    return {
      room,
      isTeacher: false,
      participantId: access.student.id,
      myRole: 'STUDENT',
      admitted: access.student.status === 'ADMITTED',
    };
  }

  return null;
}

function serializeMessage(m: {
  id: string;
  roomId: string;
  senderParticipantId: string;
  body: string;
  scope: string;
  recipientParticipantId: string | null;
  createdAt: Date;
  sender: { id: string; displayName: string; role: string };
  recipient: { id: string; displayName: string; role: string } | null;
}) {
  return {
    id: m.id,
    roomId: m.roomId,
    senderParticipantId: m.senderParticipantId,
    senderName: m.sender.displayName,
    senderRole: m.sender.role,
    body: m.body,
    scope: m.scope,
    recipientParticipantId: m.recipientParticipantId,
    recipientName: m.recipient?.displayName ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}

const messageInclude = {
  sender: { select: { id: true, displayName: true, role: true } },
  recipient: { select: { id: true, displayName: true, role: true } },
} as const;

export async function GET(req: Request, { params }: { params: { code: string } }) {
  const code = params.code.toUpperCase();
  const ctx = await resolveAccess(req, code);
  if (!ctx) return jsonError('Unauthorized', 401);

  if (ctx.room.status === 'ENDED') {
    return jsonOk({ messages: [], ended: true }, { status: 200 });
  }

  // Waiting students can read nothing (or empty); stick to admitted + teacher
  if (!ctx.admitted) return jsonError('Not admitted', 403);

  const all = await prisma.message.findMany({
    where: { roomId: ctx.room.id },
    orderBy: { createdAt: 'asc' },
    include: messageInclude,
    take: 500,
  });

  const visible = ctx.isTeacher
    ? all
    : all.filter((m) => {
        if (m.scope === 'BROADCAST') return true;
        if (m.scope === 'TEACHER' && m.senderParticipantId === ctx.participantId) return true;
        if (m.scope === 'DIRECT' && m.recipientParticipantId === ctx.participantId) return true;
        // Also show DMs the student somehow sent (shouldn't happen) — skip
        return false;
      });

  return jsonOk({
    messages: visible.map(serializeMessage),
    ended: false,
  });
}

const postSchema = z.object({
  text: z.string().trim().min(1).max(MAX_BODY),
  to: z.union([z.literal('teacher'), z.literal('all'), z.string().min(1)]).optional(),
});

export async function POST(req: Request, { params }: { params: { code: string } }) {
  const code = params.code.toUpperCase();
  const ctx = await resolveAccess(req, code);
  if (!ctx) return jsonError('Unauthorized', 401);

  if (ctx.room.status === 'ENDED') {
    return jsonError('Class has ended', 410);
  }
  if (!ctx.admitted) return jsonError('Not admitted', 403);
  if (!ctx.participantId) return jsonError('No participant identity', 400);

  let body: z.infer<typeof postSchema>;
  try {
    body = postSchema.parse(await req.json());
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    return jsonError('Invalid JSON');
  }

  const text = body.text.slice(0, MAX_BODY);

  try {
    if (ctx.isTeacher) {
      // Require explicit recipient — never silently default to broadcast
      if (body.to == null || body.to === '') {
        return jsonError("Teacher messages require to: 'all' or a student participant id", 400);
      }
      const to = body.to;

      if (to === 'all') {
        const msg = await prisma.message.create({
          data: {
            roomId: ctx.room.id,
            senderParticipantId: ctx.participantId,
            body: text,
            scope: 'BROADCAST',
          },
          include: messageInclude,
        });
        return jsonOk({ message: serializeMessage(msg) });
      }

      if (to === 'teacher') {
        return jsonError('Teachers cannot message teacher; use all or a student id', 400);
      }

      // Direct to student participant id
      const recipient = await prisma.participant.findFirst({
        where: {
          id: to,
          roomId: ctx.room.id,
          role: 'STUDENT',
          status: 'ADMITTED',
        },
      });
      if (!recipient) return jsonError('Student not found', 404);

      const msg = await prisma.message.create({
        data: {
          roomId: ctx.room.id,
          senderParticipantId: ctx.participantId,
          body: text,
          scope: 'DIRECT',
          recipientParticipantId: recipient.id,
        },
        include: messageInclude,
      });
      return jsonOk({ message: serializeMessage(msg) });
    }

    // Student: only to teacher
    const to = body.to ?? 'teacher';
    if (to !== 'teacher') {
      return jsonError('Students can only message the teacher', 403);
    }

    const msg = await prisma.message.create({
      data: {
        roomId: ctx.room.id,
        senderParticipantId: ctx.participantId,
        body: text,
        scope: 'TEACHER',
      },
      include: messageInclude,
    });
    return jsonOk({ message: serializeMessage(msg) });
  } catch (e) {
    console.error(e);
    return jsonError('Failed to send message', 500);
  }
}

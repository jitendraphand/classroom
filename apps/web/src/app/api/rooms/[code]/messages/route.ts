import { z } from 'zod';
import { prisma } from '@/lib/db';
import { roomRowCached } from '@/lib/roomStateCache';
import { resolveRoomAccess } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { livekitRoomName, sendRoomData } from '@/lib/livekit';
import { chatAudience } from '@/lib/chatAudience';
import { publishChat } from '@/lib/chatBus';
import { CHAT_TOPIC } from '@/lib/realtimePackets';

export const dynamic = 'force-dynamic';

const MAX_BODY = 2000;
/** Newest N messages retained per client's view of a room. */
const MAX_HISTORY = 500;
const SINCE_OVERLAP_MS = 5_000;

type AccessCtx = {
  room: { id: string; code: string; status: string; teacherId: string; sessionId: string };
  isTeacher: boolean;
  participantId: string | null;
  myRole: 'TEACHER' | 'STUDENT' | null;
  admitted: boolean;
};

async function resolveAccess(
  req: Request,
  code: string,
  preloaded?: Awaited<ReturnType<typeof prisma.room.findUnique>>,
): Promise<AccessCtx | null> {
  const room = preloaded ?? (await roomRowCached(code));
  if (!room) return null;

  const url = new URL(req.url);
  const forceStudent =
    url.searchParams.get('as') === 'student' ||
    req.headers.get('x-classroom-as') === 'student';
  const access = await resolveRoomAccess(room, { forceStudent });

  if (access.isTeacher) {
    const teacherParticipant = await prisma.participant.findFirst({
      where: { roomId: room.id, role: 'TEACHER', status: 'ADMITTED' },
      select: { id: true },
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

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  // Ended rooms answer "ended" before the access check: students are marked
  // LEFT when the class ends, and their last poll must not log a 401. Nothing
  // about the room is revealed beyond the fact that it ended.
  // One room read serves both the ended check and the access check.
  const room = await prisma.room.findUnique({ where: { code } });
  if (room?.status === 'ENDED') {
    return jsonOk({ messages: [], ended: true }, { status: 200 });
  }
  if (!room) return jsonError('Unauthorized', 401);
  const ctx = await resolveAccess(req, code, room);
  if (!ctx) return jsonError('Unauthorized', 401);

  // Waiting students can read nothing (or empty); stick to admitted + teacher
  if (!ctx.admitted) return jsonError('Not admitted', 403);

  // A student only ever sees broadcasts, their own messages to the teacher, and
  // DMs addressed to them. Filtering in the WHERE clause keeps other students'
  // messages (notably the teacher's DMs naming a classmate) out of the result
  // set entirely, rather than pulling every row and discarding it in JS.
  // ?since=<ISO>: only newer rows (the poll after hydration). A small overlap
  // covers clock skew between workers; the client merges by id.
  const sinceRaw = new URL(req.url).searchParams.get('since');
  const sinceMs = sinceRaw ? Date.parse(sinceRaw) : NaN;
  const createdAt = Number.isFinite(sinceMs) ? { gt: new Date(sinceMs - SINCE_OVERLAP_MS) } : undefined;
  const where = ctx.isTeacher
    ? { roomId: ctx.room.id, ...(createdAt ? { createdAt } : {}) }
    : {
        roomId: ctx.room.id,
        ...(createdAt ? { createdAt } : {}),
        OR: [
          { scope: 'BROADCAST' as const },
          { scope: 'TEACHER' as const, senderParticipantId: ctx.participantId ?? '__none__' },
          { scope: 'DIRECT' as const, recipientParticipantId: ctx.participantId ?? '__none__' },
        ],
      };

  // Newest-first with `take` so the cap keeps the MOST RECENT history; taking the
  // oldest 500 meant new messages silently stopped appearing once a chatty class
  // crossed the threshold. Reversed below to keep the client order ascending.
  const rows = await prisma.message.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: messageInclude,
    take: MAX_HISTORY,
  });
  const all = rows.reverse();

  return jsonOk({
    messages: all.map(serializeMessage),
    ended: false,
  });
}

/**
 * Low-latency delivery of a message that was just stored. The sender also
 * publishes on the chat topic (SFU fan-out). This server send remains as a
 * backup for clients that cannot publish. Clients merge by message id.
 */
async function pushMessage(
  room: AccessCtx['room'],
  msg: Parameters<typeof serializeMessage>[0]
) {
  // Scoped messages need the teacher(s) and one student, not the whole roster
  // (2,000 rows per student→teacher message in a big class).
  const scoped = msg.scope !== 'BROADCAST';
  const ids = [msg.senderParticipantId, msg.recipientParticipantId].filter((x): x is string => !!x);
  const people = await prisma.participant.findMany({
    where: scoped
      ? { roomId: room.id, status: 'ADMITTED', OR: [{ role: 'TEACHER' }, { id: { in: ids } }] }
      : { roomId: room.id, status: 'ADMITTED' },
    select: { id: true, role: true, livekitIdentity: true },
  });
  const audience = chatAudience(
    {
      scope: msg.scope as 'BROADCAST' | 'TEACHER' | 'DIRECT',
      senderParticipantId: msg.senderParticipantId,
      recipientParticipantId: msg.recipientParticipantId,
    },
    people
  );
  const audienceSet = new Set(audience);
  // Broadcast: '*' instead of 2,000 ids in every Redis payload.
  const allowedIds = scoped ? people.filter((p) => audienceSet.has(p.livekitIdentity)).map((p) => p.id) : ['*'];
  void publishChat(room.code, serializeMessage(msg), allowedIds).catch((e) => console.warn('chat sse', e));
  if (audience.length === 0) return;
  await sendRoomData(
    livekitRoomName(room.code, room.sessionId),
    { v: 1, type: 'message', message: serializeMessage(msg) },
    { topic: CHAT_TOPIC, destinationIdentities: audience }
  );
}

const postSchema = z.object({
  text: z.string().trim().min(1).max(MAX_BODY),
  to: z.union([z.literal('teacher'), z.literal('all'), z.string().min(1)]).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
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
        void pushMessage(ctx.room, msg).catch((e) => console.warn('chat push', e));
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
      void pushMessage(ctx.room, msg).catch((e) => console.warn('chat push', e));
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
    void pushMessage(ctx.room, msg).catch((e) => console.warn('chat push', e));
    return jsonOk({ message: serializeMessage(msg) });
  } catch (e) {
    console.error(e);
    return jsonError('Failed to send message', 500);
  }
}

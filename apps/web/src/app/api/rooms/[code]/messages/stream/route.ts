import { prisma } from '@/lib/db';
import { resolveRoomAccess } from '@/lib/auth';
import { ensureRedis, keys } from '@/lib/redis';
import { chatVisibleTo, type ChatPush } from '@/lib/chatBus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Server-sent events for chat. Redis pub/sub, filtered per viewer, so a
 * student→teacher message arrives without waiting for the poll.
 */
export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.status === 'ENDED') return new Response('ended', { status: 410 });

  const url = new URL(req.url);
  const forceStudent = url.searchParams.get('as') === 'student' || req.headers.get('x-classroom-as') === 'student';
  const access = await resolveRoomAccess(room, { forceStudent });
  let isTeacher = false;
  let participantId: string | null = null;
  if (access.isTeacher) {
    isTeacher = true;
    const teacherParticipant = await prisma.participant.findFirst({
      where: { roomId: room.id, role: 'TEACHER', status: 'ADMITTED' },
      select: { id: true },
    });
    participantId = teacherParticipant?.id ?? null;
  } else if (access.mode === 'student' && access.student && access.student.roomId === room.id && access.student.status === 'ADMITTED') {
    participantId = access.student.id;
  } else {
    return new Response('Unauthorized', { status: 401 });
  }

  const encoder = new TextEncoder();
  const redis = await ensureRedis();
  const sub = redis.duplicate();
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (line: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(line));
        } catch {
          closed = true;
        }
      };
      send('retry: 2000\n\n');
      send(`data: ${JSON.stringify({ type: 'ready' })}\n\n`);
      sub.on('message', (_channel: string, raw: string) => {
        let push: ChatPush;
        try {
          push = JSON.parse(raw) as ChatPush;
        } catch {
          return;
        }
        if (!push?.message || !chatVisibleTo(push, { isTeacher, participantId })) return;
        send(`data: ${JSON.stringify({ type: 'message', message: push.message })}\n\n`);
      });
      try {
        if (sub.status === 'wait' || sub.status === 'end') await sub.connect();
        await sub.subscribe(keys.chatChannel(code));
      } catch (e) {
        console.warn('chat subscribe', e);
      }
      const ping = setInterval(() => send(': ping\n\n'), 15000);
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        void sub.unsubscribe().catch(() => undefined);
        sub.disconnect();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener('abort', close);
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

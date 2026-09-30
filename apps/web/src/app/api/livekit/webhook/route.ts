import { WebhookReceiver } from 'livekit-server-sdk';
import { prisma } from '@/lib/db';
import { jsonError, jsonOk } from '@/lib/response';
import {
  applyStudentMicLock,
  isTeacherPresent,
  listRoomParticipants,
  recordTeacherPresence,
} from '@/lib/teacherPresence';
import { handlePresenceEvent } from '@/lib/teacherPresenceLogic';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * LiveKit server webhook (configured in infra/livekit.yaml → webhook.urls).
 * Authenticated by the signed Authorization JWT + body sha256 that
 * WebhookReceiver verifies with the LiveKit API key/secret; exempt from the
 * browser CSRF guard (see lib/csrf.ts). Drives the "students are force-muted
 * while the teacher is not connected" rule.
 */
export async function POST(req: Request) {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) return jsonError('Webhook not configured', 503);

  const body = await req.text();
  const auth = req.headers.get('authorization') ?? undefined;

  let event;
  try {
    event = await new WebhookReceiver(apiKey, apiSecret).receive(body, auth);
  } catch {
    // Never echo why: bad signature, wrong key, tampered body.
    return jsonError('Invalid webhook signature', 401);
  }

  try {
    const outcome = await handlePresenceEvent(
      {
        event: event.event,
        room: event.room ? { name: event.room.name } : null,
        participant: event.participant
          ? {
              identity: event.participant.identity,
              sid: event.participant.sid,
              metadata: event.participant.metadata,
              state: event.participant.state,
            }
          : null,
      },
      {
        findRoom: (code) =>
          prisma.room.findUnique({
            where: { code },
            select: { code: true, sessionId: true, status: true },
          }),
        listParticipants: listRoomParticipants,
        isTeacherPresent: (room) => isTeacherPresent(room.code, room),
        recordPresence: (room, present) => recordTeacherPresence(room, present, 'webhook'),
        applyStudentMicLock,
      }
    );
    return jsonOk({ ok: true, ...outcome });
  } catch (e) {
    console.error('LiveKit webhook handling failed', event.event, e instanceof Error ? e.message : e);
    // 500 makes LiveKit retry the delivery.
    return jsonError('Webhook handling failed', 500);
  }
}

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
import { recordConnectionEvent } from '@/lib/attendanceService';

/** Event time from the webhook (seconds, int64), falling back to now if absent/odd. */
function eventTime(createdAt: unknown): Date {
  const now = Date.now();
  const n = typeof createdAt === 'bigint' ? Number(createdAt) : Number(createdAt ?? 0);
  const ms = n * 1000;
  return Number.isFinite(ms) && ms > 0 && Math.abs(ms - now) < 6 * 3600_000 ? new Date(ms) : new Date(now);
}

/**
 * Student connect/disconnect → attendance connected time. Idempotent per
 * participant SID, so a LiveKit retry cannot double count. Never fails the
 * webhook (presence handling is what LiveKit should retry).
 */
async function recordAttendance(event: {
  event?: string;
  createdAt?: unknown;
  participant?: { identity?: string; sid?: string } | null;
}) {
  const identity = event.participant?.identity;
  const sid = event.participant?.sid;
  if (!identity || !sid || !identity.startsWith('student_')) return;
  const kind =
    event.event === 'participant_joined'
      ? 'joined'
      : event.event === 'participant_left' || event.event === 'participant_connection_aborted'
        ? 'left'
        : null;
  if (!kind) return;
  try {
    await recordConnectionEvent(kind, identity, sid, eventTime(event.createdAt));
  } catch (e) {
    console.error('attendance webhook', event.event, e instanceof Error ? e.message : e);
  }
}

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
    await recordAttendance(event);
    return jsonOk({ ok: true, ...outcome });
  } catch (e) {
    console.error('LiveKit webhook handling failed', event.event, e instanceof Error ? e.message : e);
    // 500 makes LiveKit retry the delivery.
    return jsonError('Webhook handling failed', 500);
  }
}

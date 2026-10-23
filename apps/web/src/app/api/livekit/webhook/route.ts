import { mediaServers } from '@/lib/mediaServers';
import { WebhookReceiver } from 'livekit-server-sdk';
import { prisma } from '@/lib/db';
import { jsonError, jsonOk } from '@/lib/response';
import {
  applyStudentMicLock,
  cancelTeacherAbsence,
  deferTeacherAbsence,
  isTeacherPresent,
  listRoomParticipants,
  recordTeacherGrace,
  recordTeacherPresence,
} from '@/lib/teacherPresence';
import { handlePresenceEvent, parseLivekitRoomName } from '@/lib/teacherPresenceLogic';
import { recordStudentConnection } from '@/lib/studentPresence';
import { recordConnectionEvent } from '@/lib/attendanceService';
import { HANDLED_WEBHOOK_EVENTS, KeyedWorkQueue, TtlCache } from '@/lib/webhookQueue';

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
  room?: { name?: string } | null;
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
    const room = parseLivekitRoomName(event.room?.name);
    if (room) await recordStudentConnection(room.code, identity, kind, sid);
  } catch (e) {
    console.error('student presence webhook', event.event, e instanceof Error ? e.message : e);
  }
  try {
    await recordConnectionEvent(kind, identity, sid, eventTime(event.createdAt));
  } catch (e) {
    console.error('attendance webhook', event.event, e instanceof Error ? e.message : e);
  }
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type QueuedEvent = {
  event: string;
  room: { name: string } | null;
  participant: { identity: string; sid: string; metadata?: string; state?: number } | null;
  createdAt?: unknown;
};

type RoomRow = { code: string; sessionId: string | null; status: string };
/** One room lookup per room per 3 s, not one per student join (2,000 joins in a minute). */
const roomCache = new TtlCache<RoomRow | null>(3_000, 500);
async function findRoomCached(code: string) {
  const hit = roomCache.get(code);
  if (hit !== undefined) return hit;
  const row = await prisma.room.findUnique({
    where: { code },
    select: { code: true, sessionId: true, status: true },
  });
  roomCache.set(code, row as RoomRow | null);
  return row;
}

async function processEvent(event: QueuedEvent) {
  if (event.event === 'room_finished' && event.room?.name) {
    const parsed = parseLivekitRoomName(event.room.name);
    if (parsed) roomCache.delete(parsed.code);
  }
  try {
    await handlePresenceEvent(
      { event: event.event, room: event.room, participant: event.participant },
      {
        findRoom: findRoomCached as Parameters<typeof handlePresenceEvent>[1]['findRoom'],
        listParticipants: listRoomParticipants,
        isTeacherPresent: (room) => isTeacherPresent(room.code, room),
        recordPresence: (room, present) => recordTeacherPresence(room, present, 'webhook'),
        applyStudentMicLock,
        // 15 s grace before force-muting students when the teacher drops.
        deferAbsence: deferTeacherAbsence,
        cancelAbsence: cancelTeacherAbsence,
        recordGrace: recordTeacherGrace,
      }
    );
  } catch (e) {
    console.error('LiveKit webhook handling failed', event.event, e instanceof Error ? e.message : e);
  }
  await recordAttendance(event);
}

const g = globalThis as unknown as { __lkWebhookQueue?: KeyedWorkQueue<QueuedEvent> };
const queue = (g.__lkWebhookQueue ??= new KeyedWorkQueue<QueuedEvent>({
  keyOf: (e) => e.room?.name ?? '',
  handle: processEvent,
  maxSize: Number(process.env.WEBHOOK_QUEUE_MAX) || 20_000,
  batchSize: 64,
  concurrency: Number(process.env.WEBHOOK_CONCURRENCY) || 16,
  onDrop: (n) => console.warn(`[webhook] queue full, dropped ${n} oldest event(s)`),
}));

/**
 * LiveKit server webhook (configured in infra/livekit.yaml → webhook.urls).
 * Authenticated by the signed Authorization JWT + body sha256 that
 * WebhookReceiver verifies with the LiveKit API key/secret; exempt from the
 * browser CSRF guard (see lib/csrf.ts). Drives the "students are force-muted
 * while the teacher is not connected" rule and attendance.
 *
 * Fast path: verify, enqueue, answer 200 immediately. Work runs in the
 * background queue (lib/webhookQueue), so LiveKit's own webhook queue never
 * backs up behind database writes. Events the classroom ignores
 * (track_published, ...) are acked without queueing.
 */
export async function POST(req: Request) {
  // Any registered media node may call (multi-server); each signs with its own key.
  const signers = mediaServers().filter((s) => s.apiKey && s.apiSecret);
  if (!signers.length) return jsonError('Webhook not configured', 503);

  const body = await req.text();
  const auth = req.headers.get('authorization') ?? undefined;

  let event;
  for (const s of signers) {
    try {
      event = await new WebhookReceiver(s.apiKey, s.apiSecret).receive(body, auth);
      break;
    } catch {
      /* try the next node's key */
    }
  }
  // Never echo why: bad signature, wrong key, tampered body.
  if (!event) return jsonError('Invalid webhook signature', 401);

  if (!HANDLED_WEBHOOK_EVENTS.has(event.event)) return jsonOk({ ok: true, queued: false });
  queue.push({
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
    createdAt: event.createdAt,
  });
  return jsonOk({ ok: true, queued: true });
}

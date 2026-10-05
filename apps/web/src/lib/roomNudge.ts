import { prisma } from '@/lib/db';
import { livekitRoomName, sendRoomData } from '@/lib/livekit';
import { STATE_TOPIC, mergeAudience, type NudgeAudience } from '@/lib/pollPolicy';

/**
 * Tell connected classroom clients that /state changed so they refetch now
 * instead of waiting for their (slow) safety poll. Coalesced per room: a burst
 * of changes within NUDGE_COALESCE_MS sends one packet. Fire-and-forget: never
 * throws and never delays the calling route.
 */
const NUDGE_COALESCE_MS = 200;
const pending = new Map<string, { audience: NudgeAudience; timer: ReturnType<typeof setTimeout> }>();

export function nudgeRoomState(roomCode: string | null | undefined, audience: NudgeAudience = 'all') {
  if (!roomCode) return;
  const cur = pending.get(roomCode);
  if (cur) {
    cur.audience = mergeAudience(cur.audience, audience);
    return;
  }
  const entry = {
    audience,
    timer: setTimeout(() => {
      pending.delete(roomCode);
      void send(roomCode, entry.audience);
    }, NUDGE_COALESCE_MS),
  };
  pending.set(roomCode, entry);
}

async function send(roomCode: string, audience: NudgeAudience) {
  try {
    const room = await prisma.room.findUnique({
      where: { code: roomCode },
      select: { id: true, code: true, sessionId: true },
    });
    if (!room) return;
    let destinationIdentities: string[] | undefined;
    if (audience === 'teacher') {
      const teachers = await prisma.participant.findMany({
        where: { roomId: room.id, role: 'TEACHER', status: 'ADMITTED' },
        select: { livekitIdentity: true },
      });
      destinationIdentities = teachers.map((t) => t.livekitIdentity);
      if (destinationIdentities.length === 0) return;
    }
    await sendRoomData(
      livekitRoomName(room.code, room.sessionId),
      { v: 1, type: 'state' },
      { topic: STATE_TOPIC, destinationIdentities }
    );
  } catch (e) {
    console.warn('nudgeRoomState', e instanceof Error ? e.message : e);
  }
}

/**
 * Tell specific students their teacher-mute flag right away (no coalescing,
 * no refetch needed to update the mic button). The regular nudge still
 * follows for everyone else.
 */
export function pushMuteState(roomCode: string, sessionId: string, identities: string[], muted: boolean) {
  if (!identities.length) return;
  void sendRoomData(
    livekitRoomName(roomCode, sessionId),
    { v: 1, type: 'mute', muted },
    { topic: STATE_TOPIC, destinationIdentities: identities }
  ).catch(() => undefined);
}

import { prisma } from './db';
import { livekitRoomName, roomService } from './livekit';
import { ensureRedis, keys } from './redis';

/**
 * Server-side half of "one active session per account": when a teacher/admin
 * signs in again, the previous device's LiveKit connections are removed right
 * away (its tab also stops itself when its next API call reports
 * 'signed_in_elsewhere'). Best effort: a LiveKit hiccup never fails a login.
 */

function notFound(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return /not.?found|does not exist/i.test(msg);
}

/** Back to the idle stage and drop the share's annotations. */
export async function clearStage(code: string): Promise<void> {
  try {
    const redis = await ensureRedis();
    await redis.set(keys.stage(code), 'idle', 'EX', 60 * 60 * 6);
    await redis.del(keys.annotate(code));
  } catch {
    /* Redis down: the new device's first room snapshot clears it */
  }
}

/** Disconnect the teacher's identity from each of their open classes. */
export async function kickReplacedTeacher(teacherId: string): Promise<void> {
  try {
    const rooms = await prisma.room.findMany({
      where: { teacherId, status: { not: 'ENDED' } },
      select: { id: true, code: true, sessionId: true },
    });
    for (const room of rooms) {
      const teachers = await prisma.participant.findMany({
        where: { roomId: room.id, role: 'TEACHER' },
        select: { livekitIdentity: true },
      });
      // The old device's screen share ends with it: no stale "Teacher screen" stage.
      await clearStage(room.code);
      for (const t of teachers) {
        await roomService()
          .removeParticipant(livekitRoomName(room.code, room.sessionId), t.livekitIdentity)
          .catch((e) => {
            if (!notFound(e)) console.warn('kickReplacedTeacher', room.code, e instanceof Error ? e.message : e);
          });
      }
    }
  } catch (e) {
    console.warn('kickReplacedTeacher failed', e instanceof Error ? e.message : e);
  }
}

/** Identities minted for this admin's "Ongoing classes" viewers (see livekit.observerIdentity). */
export function isAdminObserverOf(identity: string, adminId: string): boolean {
  return identity.startsWith(`adminobserver_${adminId}_`) || identity.startsWith(`adminpreview_${adminId}_`);
}

/** Stop the admin's open class viewers/previews in every live class. */
export async function kickReplacedAdmin(adminId: string): Promise<void> {
  try {
    const svc = roomService();
    const rooms = await svc.listRooms();
    for (const r of rooms) {
      if (!r.name.startsWith('classroom_')) continue;
      const participants = await svc.listParticipants(r.name).catch(() => []);
      for (const p of participants) {
        if (!isAdminObserverOf(p.identity, adminId)) continue;
        await svc.removeParticipant(r.name, p.identity).catch(() => undefined);
      }
    }
  } catch (e) {
    console.warn('kickReplacedAdmin failed', e instanceof Error ? e.message : e);
  }
}

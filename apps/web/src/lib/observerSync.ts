import { prisma } from './db';
import { ensureRedis, keys } from './redis';
import { pushStudentPermissions } from './livekit';
import { getVisibleSample } from './sample';
import { nudgeRoomState } from './roomNudge';

/**
 * Push student camera publish permissions when a room transitions between
 * having an active admin observer and having none, and nudge connected
 * students so SelectivePublisher + StudentMediaPrivacy apply immediately.
 */
export async function syncObserverCameras(code: string, observerActive: boolean): Promise<void> {
  try {
    const room = await prisma.room.findUnique({
      where: { code },
      select: { id: true, code: true, sessionId: true, status: true },
    });
    if (!room || room.status === 'ENDED') return;
    const students = await prisma.participant.findMany({
      where: { roomId: room.id, role: 'STUDENT', status: 'ADMITTED' },
      select: { id: true, livekitIdentity: true, mutedByTeacher: true },
    });
    if (students.length) {
      const redis = await ensureRedis();
      const [{ visible }, mutedIds] = await Promise.all([
        getVisibleSample(code),
        redis.smembers(keys.muted(code)),
      ]);
      const inSample = new Set(visible);
      const muted = new Set(mutedIds);
      await pushStudentPermissions(
        code,
        students.map((s) => ({
          identity: s.livekitIdentity,
          allowCamera: observerActive || inSample.has(s.livekitIdentity),
          allowMic: !(s.mutedByTeacher || muted.has(s.id)),
        })),
        { room: { code: room.code, sessionId: room.sessionId }, observerActive }
      );
    }
    nudgeRoomState(code, 'all');
  } catch (e) {
    console.warn('syncObserverCameras', code, e instanceof Error ? e.message : e);
  }
}

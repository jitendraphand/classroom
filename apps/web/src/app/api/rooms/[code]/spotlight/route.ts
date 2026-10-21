import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureRedis, keys } from '@/lib/redis';
import { nudgeRoomState } from '@/lib/roomNudge';
import { setParticipantCameraAllowed } from '@/lib/livekit';
import { getVisibleSample } from '@/lib/sample';

/** Grant or restore this student's camera publish. Call after the spotlight key is updated. */
async function syncSpotlightCamera(code: string, participantId: string, spotlightOn: boolean) {
  const student = await prisma.participant.findFirst({
    where: { id: participantId, role: 'STUDENT' },
    select: { livekitIdentity: true, mutedByTeacher: true },
  });
  if (!student) return;
  const redis = await ensureRedis();
  const muted = student.mutedByTeacher || (await redis.sismember(keys.muted(code), participantId)) === 1;
  let allowCamera = spotlightOn;
  if (!spotlightOn) {
    const { visible } = await getVisibleSample(code);
    allowCamera = visible.includes(student.livekitIdentity);
  }
  await setParticipantCameraAllowed(code, student.livekitIdentity, allowCamera, !muted);
}

export const dynamic = 'force-dynamic';

/** Teacher picks one admitted student whose camera the class may see. Null stops it. */
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);
  const code = (await params).code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.teacherId !== teacher.id) return jsonError('Room not found', 404);
  if (room.status === 'ENDED') return jsonError('Class ended', 410);

  const body = (await req.json().catch(() => null)) as { participantId?: unknown } | null;
  const participantId = body?.participantId;
  const redis = await ensureRedis();
  if (participantId == null || participantId === '') {
    const prev = await redis.get(keys.spotlight(code));
    await redis.del(keys.spotlight(code));
    if (prev) await syncSpotlightCamera(code, prev, false);
    nudgeRoomState(code, 'all');
    return jsonOk({ spotlight: null });
  }
  if (typeof participantId !== 'string') return jsonError('participantId must be a student id or null');
  const student = await prisma.participant.findFirst({
    where: { id: participantId, roomId: room.id, role: 'STUDENT', status: 'ADMITTED' },
    select: { id: true, displayName: true, livekitIdentity: true },
  });
  if (!student) return jsonError('Student not found', 404);
  const prev = await redis.get(keys.spotlight(code));
  await redis.set(keys.spotlight(code), student.id, 'EX', 12 * 60 * 60);
  if (prev && prev !== student.id) await syncSpotlightCamera(code, prev, false);
  await syncSpotlightCamera(code, student.id, true);
  nudgeRoomState(code, 'all');
  return jsonOk({
    spotlight: { participantId: student.id, identity: student.livekitIdentity, name: student.displayName },
  });
}

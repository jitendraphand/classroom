import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { clampMaxVisible, rotateVisibleSample } from '@/lib/sample';
import { admitWaiting } from '@/lib/admission';
import { idsToAdmitOnToggle } from '@/lib/admissionLogic';

const schema = z.object({
  maxVisibleVideos: z.number().int().min(1).max(6).optional(),
  name: z.string().min(1).max(120).optional(),
  /** Waiting room for this class session (off: students enter directly). */
  waitingRoomOn: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);

  const code = (await params).code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.teacherId !== teacher.id) return jsonError('Room not found', 404);

  try {
    const body = schema.parse(await req.json());
    const updated = await prisma.room.update({
      where: { id: room.id },
      data: {
        ...(body.maxVisibleVideos !== undefined ? { maxVisibleVideos: clampMaxVisible(body.maxVisibleVideos) } : {}),
        ...(body.name ? { name: body.name.trim() } : {}),
        ...(body.waitingRoomOn !== undefined ? { waitingRoomOn: body.waitingRoomOn } : {}),
      },
    });
    let admitted = 0;
    if (body.waitingRoomOn === false && updated.status !== 'ENDED') {
      // Waiting room off: everyone already waiting comes in now.
      const waiting = await prisma.participant.findMany({
        where: { roomId: room.id, role: 'STUDENT', status: 'WAITING' },
        select: { id: true, role: true, status: true },
      });
      const ids = idsToAdmitOnToggle(false, waiting);
      if (ids.length) admitted = await admitWaiting(updated, { ids });
    }
    if (body.maxVisibleVideos !== undefined) await rotateVisibleSample(code, updated.maxVisibleVideos);
    return jsonOk({
      maxVisibleVideos: updated.maxVisibleVideos,
      name: updated.name,
      waitingRoomOn: updated.waitingRoomOn,
      admitted,
    });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    console.error(e);
    return jsonError('Update failed', 500);
  }
}

import { requireAdminApi } from '@/lib/adminGuard';
import { handleAdminEndClass } from '@/lib/adminLiveApi';
import { prisma } from '@/lib/db';
import { isOngoingClass } from '@/lib/liveClassesLogic';
import { endRoom } from '@/lib/teacherRoom';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Admin (SYSTEM or sub-admin with monitorLive): end a live class for everyone.
 * Reuses the teacher's `endRoom` close path (session, attendance, LiveKit).
 */
export async function POST(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  return handleAdminEndClass((await params).code, {
    guard: () => requireAdminApi('monitorLive'),
    load: async (code) => {
      const room = await prisma.room.findUnique({
        where: { code },
        select: { id: true, code: true, sessionId: true, classSessionId: true, status: true },
      });
      if (!room?.classSessionId || room.status === 'ENDED') return null;
      const cs = await prisma.classSession.findUnique({
        where: { id: room.classSessionId },
        select: { id: true, startedAt: true, endedAt: true },
      });
      if (!cs || !isOngoingClass(room, cs)) return null;
      return room;
    },
    end: (room, actor) => endRoom(room, actor),
  });
}

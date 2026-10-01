import { z } from 'zod';
import { getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { clampMaxVisible, sampleConfig } from '@/lib/sample';
import { resolveAppUrl } from '@/lib/url';
import { SessionError, startDefaultClass } from '@/lib/classSessions';

const schema = z.object({
  name: z.string().min(1).max(120).optional(),
  maxVisibleVideos: z.number().int().min(1).max(6).optional(),
});

/**
 * Legacy "Start class" (Android app). Re-enters the open class, else starts
 * the teacher's timetabled class that is open now, else an ad-hoc class for
 * their only assigned grade. The web dashboard uses /api/teacher/sessions/start.
 */
export async function POST(req: Request) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);

  try {
    const body = schema.parse(await req.json().catch(() => ({})));
    const max = clampMaxVisible(body.maxVisibleVideos ?? sampleConfig().maxVisible);
    const { room, classSession } = await startDefaultClass(teacher, { name: body.name, maxVisibleVideos: max });
    const appUrl = resolveAppUrl(req);
    return jsonOk({
      id: room.id,
      code: room.code,
      name: room.name,
      maxVisibleVideos: room.maxVisibleVideos,
      permanent: true,
      classSessionId: classSession.id,
      joinUrl: `${appUrl}/join/${room.code}`,
      teacherUrl: `${appUrl}/classroom/${room.code}`,
    });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    if (e instanceof SessionError) return jsonError(e.message, e.status);
    if (e instanceof Error && e.message === 'CODE_CONFLICT') {
      return jsonError('Permanent code conflict — contact support', 409);
    }
    console.error(e);
    return jsonError('Failed to start classroom', 500);
  }
}

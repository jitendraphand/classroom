import { z } from 'zod';
import { getTeacherSession } from '@/lib/auth';
import { SessionError, startAdHocClass, startScheduledClass } from '@/lib/classSessions';
import { jsonError, jsonOk } from '@/lib/response';
import { clampMaxVisible, sampleConfig } from '@/lib/sample';
import { startClassSchema } from '@/lib/teacherStartSchema';
import { resolveAppUrl } from '@/lib/url';

const schema = startClassSchema;

/** Start a timetabled class occurrence or an ad-hoc class (assigned grades only). */
export async function POST(req: Request) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);
  try {
    const body = schema.parse(await req.json());
    const maxVisibleVideos = clampMaxVisible(body.maxVisibleVideos ?? sampleConfig().maxVisible);
    const { room, classSession } =
      body.kind === 'scheduled'
        ? await startScheduledClass(teacher, body.key, { maxVisibleVideos })
        : await startAdHocClass(teacher, body, { maxVisibleVideos });
    return jsonOk({
      code: room.code,
      name: room.name,
      classSessionId: classSession.id,
      teacherUrl: `${resolveAppUrl(req)}/classroom/${room.code}`,
    });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    if (e instanceof SessionError) return jsonError(e.message, e.status);
    console.error(e);
    return jsonError('Could not start the class', 500);
  }
}

import { z } from 'zod';
import { getTeacherSession } from '@/lib/auth';
import { SessionError, startAdHocClass, startScheduledClass } from '@/lib/classSessions';
import { jsonError, jsonOk } from '@/lib/response';
import { clampMaxVisible, sampleConfig } from '@/lib/sample';
import { resolveAppUrl } from '@/lib/url';

const schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('scheduled'),
    key: z.string().min(1).max(200),
    maxVisibleVideos: z.number().int().min(1).max(6).optional(),
  }),
  z.object({
    kind: z.literal('adhoc'),
    campus: z.string().min(1).max(40),
    grade: z.string().min(1).max(16),
    divisions: z.array(z.string().max(16)).max(40).default([]),
    allDivisions: z.boolean().optional(),
    subject: z.string().max(80).optional(),
    maxVisibleVideos: z.number().int().min(1).max(6).optional(),
  }),
]);

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

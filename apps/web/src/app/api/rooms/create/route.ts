import { z } from 'zod';
import { getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { sampleConfig } from '@/lib/sample';
import { resolveAppUrl } from '@/lib/url';
import { ensureTeacherPermanentCode, startOrReopenTeacherRoom } from '@/lib/teacherRoom';

const schema = z.object({
  name: z.string().min(1).max(120).optional(),
  maxVisibleVideos: z.number().int().min(1).max(50).optional(),
});

export async function POST(req: Request) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);

  try {
    const body = schema.parse(await req.json().catch(() => ({})));
    const max = body.maxVisibleVideos ?? sampleConfig().maxVisible;
    const permanentCode =
      teacher.permanentCode || (await ensureTeacherPermanentCode(teacher.id));

    const room = await startOrReopenTeacherRoom(
      { id: teacher.id, name: teacher.name, permanentCode },
      { name: body.name, maxVisibleVideos: max }
    );

    const appUrl = resolveAppUrl(req);

    return jsonOk({
      id: room.id,
      code: room.code,
      name: room.name,
      maxVisibleVideos: room.maxVisibleVideos,
      permanent: true,
      joinUrl: `${appUrl}/join/${room.code}`,
      teacherUrl: `${appUrl}/teacher/room/${room.code}`,
    });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    if (e instanceof Error && e.message === 'CODE_CONFLICT') {
      return jsonError('Permanent code conflict — contact support', 409);
    }
    console.error(e);
    return jsonError('Failed to start classroom', 500);
  }
}

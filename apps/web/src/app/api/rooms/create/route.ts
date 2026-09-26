import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { generateRoomCode, generateIdentity, generateSessionToken } from '@/lib/codes';
import { jsonError, jsonOk } from '@/lib/response';
import { sampleConfig } from '@/lib/sample';
import { resolveAppUrl } from '@/lib/url';

const schema = z.object({
  name: z.string().min(1).max(120),
  maxVisibleVideos: z.number().int().min(1).max(50).optional(),
});

export async function POST(req: Request) {
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);

  try {
    const body = schema.parse(await req.json());
    const max = body.maxVisibleVideos ?? sampleConfig().maxVisible;

    let code = generateRoomCode();
    for (let i = 0; i < 5; i++) {
      const clash = await prisma.room.findUnique({ where: { code } });
      if (!clash) break;
      code = generateRoomCode();
    }

    // Identity must be unique across all rooms — include room code
    const teacherIdentity = generateIdentity('teacher', `${teacher.id}_${code}`);

    const room = await prisma.room.create({
      data: {
        code,
        name: body.name.trim(),
        teacherId: teacher.id,
        maxVisibleVideos: max,
        status: 'WAITING',
        participants: {
          create: {
            displayName: teacher.name,
            role: 'TEACHER',
            status: 'ADMITTED',
            livekitIdentity: teacherIdentity,
            sessionToken: generateSessionToken(),
          },
        },
      },
    });

    const appUrl = resolveAppUrl(req);

    return jsonOk({
      id: room.id,
      code: room.code,
      name: room.name,
      maxVisibleVideos: room.maxVisibleVideos,
      joinUrl: `${appUrl}/join/${room.code}`,
      teacherUrl: `${appUrl}/teacher/room/${room.code}`,
    });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    console.error(e);
    return jsonError('Failed to create room', 500);
  }
}

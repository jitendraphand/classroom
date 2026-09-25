import { z } from 'zod';
import { clearActAs, getActAs, getTeacherSession, setActAsStudent } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';

export const dynamic = 'force-dynamic';

const schema = z.object({
  mode: z.enum(['student', 'teacher', 'clear']),
});

export async function GET() {
  const teacher = await getTeacherSession();
  return jsonOk({
    actAs: getActAs(),
    teacherSignedIn: !!teacher,
    teacherName: teacher?.name ?? null,
  });
}

export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());
    if (body.mode === 'student') {
      const teacher = await getTeacherSession();
      if (!teacher) {
        // Still allow setting — harmless if not a teacher
      }
      setActAsStudent();
      return jsonOk({ actAs: 'student' });
    }
    clearActAs();
    return jsonOk({ actAs: null });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    return jsonError('Failed', 500);
  }
}

import { z } from 'zod';
import { prisma } from '@/lib/db';
import { createTeacherToken, setTeacherCookie, verifyPassword } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());
    const teacher = await prisma.teacher.findUnique({ where: { email: body.email.toLowerCase() } });
    if (!teacher || !(await verifyPassword(body.password, teacher.passwordHash))) {
      return jsonError('Invalid email or password', 401);
    }
    const token = await createTeacherToken(teacher);
    await setTeacherCookie(token);
    return jsonOk({ id: teacher.id, email: teacher.email, name: teacher.name });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    console.error(e);
    return jsonError('Login failed', 500);
  }
}

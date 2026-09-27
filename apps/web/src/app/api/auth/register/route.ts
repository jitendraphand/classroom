import { z } from 'zod';
import { prisma } from '@/lib/db';
import { createTeacherToken, hashPassword, setTeacherCookie } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { allocateUniqueCode } from '@/lib/teacherRoom';

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(80),
});

export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());
    const existing = await prisma.teacher.findUnique({ where: { email: body.email.toLowerCase() } });
    if (existing) return jsonError('Email already registered', 409);

    const permanentCode = await allocateUniqueCode();

    const teacher = await prisma.teacher.create({
      data: {
        email: body.email.toLowerCase(),
        name: body.name.trim(),
        passwordHash: await hashPassword(body.password),
        permanentCode,
      },
    });

    const token = await createTeacherToken(teacher);
    await setTeacherCookie(token);

    return jsonOk({
      id: teacher.id,
      email: teacher.email,
      name: teacher.name,
      permanentCode: teacher.permanentCode,
    });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    console.error(e);
    return jsonError('Registration failed', 500);
  }
}

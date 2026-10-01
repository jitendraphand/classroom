import { z } from 'zod';
import { requireAdminApi } from '@/lib/adminGuard';
import { parseAssignments } from '@/lib/grades';
import { jsonError, jsonOk } from '@/lib/response';
import { createTeacher, listTeachers, TeacherError } from '@/lib/teachers';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(200),
  assignments: z.string().max(2000).default(''),
});

export async function GET() {
  const { res } = await requireAdminApi();
  if (res) return res;
  return jsonOk({ teachers: await listTeachers() });
}

export async function POST(req: Request) {
  const { res } = await requireAdminApi();
  if (res) return res;
  try {
    const body = createSchema.parse(await req.json());
    const assignments = parseAssignments(body.assignments);
    const out = await createTeacher({ name: body.name, email: body.email, assignments });
    // The temporary password is returned exactly once; only its hash is stored.
    return jsonOk(out, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    if (e instanceof TeacherError) return jsonError(e.message, e.status);
    if (e instanceof Error && /Cannot read/.test(e.message)) return jsonError(e.message);
    console.error(e);
    return jsonError('Could not create teacher', 500);
  }
}

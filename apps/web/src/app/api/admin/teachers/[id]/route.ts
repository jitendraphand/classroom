import { z } from 'zod';
import { requireAdminApi } from '@/lib/adminGuard';
import { parseAssignments } from '@/lib/grades';
import { jsonError, jsonOk } from '@/lib/response';
import { TeacherError, updateTeacher } from '@/lib/teachers';

const schema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  disabled: z.boolean().optional(),
  assignments: z.string().max(2000).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { res } = await requireAdminApi();
  if (res) return res;
  try {
    const { id } = await params;
    const body = schema.parse(await req.json());
    const teacher = await updateTeacher(id, {
      name: body.name,
      disabled: body.disabled,
      assignments: body.assignments !== undefined ? parseAssignments(body.assignments) : undefined,
    });
    return jsonOk({ teacher });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    if (e instanceof TeacherError) return jsonError(e.message, e.status);
    if (e instanceof Error && /Cannot read/.test(e.message)) return jsonError(e.message);
    console.error(e);
    return jsonError('Could not update teacher', 500);
  }
}

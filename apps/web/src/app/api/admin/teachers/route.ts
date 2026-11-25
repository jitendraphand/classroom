import { z } from 'zod';
import { requireAdminApi } from '@/lib/adminGuard';
import { TEACHER_LIST_VIEW, TEACHER_NAMES_VIEW } from '@/lib/adminSections';
import { hasAnyPrivilege } from '@/lib/privileges';
import { parseAssignments } from '@/lib/grades';
import { soleCampus } from '@/lib/campusMaster';
import { jsonError, jsonOk } from '@/lib/response';
import { createTeacher, listTeachers, teacherNamesOnly, TeacherError } from '@/lib/teachers';
import { parseTeacherGender } from '@/lib/teacherSalutation';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(200),
  gender: z.enum(['male', 'female'], { required_error: "Pick the teacher's gender.", invalid_type_error: "Pick the teacher's gender." }),
  assignments: z.string().max(2000).default(''),
  /** Campus for assignment tokens without a "CAMPUS@" prefix. */
  campus: z.string().max(40).optional(),
});

export async function GET() {
  const { admin, res } = await requireAdminApi(TEACHER_NAMES_VIEW);
  if (res) return res;
  const teachers = await listTeachers();
  // Report-only sub-admins need names for the report filters, nothing else
  // (no emails, join codes or assignments), and never see the Teachers page.
  if (!hasAnyPrivilege(admin.privileges, admin.kind, TEACHER_LIST_VIEW)) {
    return jsonOk({ teachers: teacherNamesOnly(teachers) });
  }
  return jsonOk({ teachers });
}

export async function POST(req: Request) {
  const { res } = await requireAdminApi('manageTeachers');
  if (res) return res;
  try {
    const body = createSchema.parse(await req.json());
    const assignments = parseAssignments(body.assignments, body.campus || (await soleCampus()));
    const gender = parseTeacherGender(body.gender);
    if (!gender) return jsonError("Pick the teacher's gender.");
    const out = await createTeacher({ name: body.name, email: body.email, gender, assignments });
    // The temporary password is returned exactly once; only its hash is stored.
    return jsonOk(out, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    if (e instanceof TeacherError) return jsonError(e.message, e.status);
    if (e instanceof Error && /Cannot read|Pick a campus/.test(e.message)) return jsonError(e.message);
    console.error(e);
    return jsonError('Could not create teacher', 500);
  }
}

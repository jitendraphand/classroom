import { clearTeacherCookie, clearStudentCookie, clearActAs, clearAdminCookie, clearPupilCookie } from '@/lib/auth';
import { jsonOk } from '@/lib/response';

export async function POST() {
  await clearTeacherCookie();
  await clearAdminCookie();
  await clearStudentCookie();
  await clearPupilCookie();
  await clearActAs();
  return jsonOk({ ok: true });
}

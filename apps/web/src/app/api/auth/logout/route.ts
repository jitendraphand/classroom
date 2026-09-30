import { clearTeacherCookie, clearStudentCookie, clearActAs } from '@/lib/auth';
import { jsonOk } from '@/lib/response';

export async function POST() {
  await clearTeacherCookie();
  await clearStudentCookie();
  await clearActAs();
  return jsonOk({ ok: true });
}

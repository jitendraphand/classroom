import { clearTeacherCookie, clearStudentCookie } from '@/lib/auth';
import { jsonOk } from '@/lib/response';

export async function POST() {
  await clearTeacherCookie();
  clearStudentCookie();
  return jsonOk({ ok: true });
}

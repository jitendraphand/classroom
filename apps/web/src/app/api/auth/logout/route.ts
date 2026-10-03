import { endCurrentSessions, clearTeacherCookie, clearStudentCookie, clearActAs, clearAdminCookie, clearPupilCookie } from '@/lib/auth';
import { jsonOk } from '@/lib/response';

export async function POST() {
  // End the session server-side first, so a copied cookie stops working too.
  await endCurrentSessions();
  await clearTeacherCookie();
  await clearAdminCookie();
  await clearStudentCookie();
  await clearPupilCookie();
  await clearActAs();
  return jsonOk({ ok: true });
}

import { clearAdminCookie, clearTeacherCookie, staffSessionCheck } from '@/lib/auth';
import { jsonOk } from '@/lib/response';

export const dynamic = 'force-dynamic';

/**
 * Is this browser's staff (teacher/admin) session still the account's active
 * one? `reason` explains an ended session ('signed_in_elsewhere', 'revoked',
 * 'disabled', 'expired', 'signed_out'); the client's SessionGuard shows it.
 * The dead cookie is cleared so later pages do not keep reporting it.
 */
export async function GET() {
  const { role, status } = await staffSessionCheck();
  if (!role || !status) return jsonOk({ role: null, reason: null });
  if (status === 'ok') return jsonOk({ role, reason: null });
  if (role === 'admin') await clearAdminCookie();
  else await clearTeacherCookie();
  return jsonOk({ role, reason: status === 'missing' ? 'signed_out' : status });
}

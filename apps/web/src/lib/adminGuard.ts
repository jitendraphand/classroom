import { endedSessionReason, getAdminSession, type AdminSession } from './auth';
import { jsonError } from './response';

/**
 * Admin-only API guard. Returns the admin session or a ready 401 response.
 * Teachers have no admin cookie (separate cookie + role claim), so a teacher
 * session can never satisfy this, whatever it sends.
 */
export async function requireAdminApi(): Promise<
  { admin: AdminSession; res?: undefined } | { admin?: undefined; res: Response }
> {
  const admin = await getAdminSession();
  if (!admin) return { res: jsonError('Admin sign-in required', 401, { reason: await endedSessionReason() }) };
  return { admin };
}

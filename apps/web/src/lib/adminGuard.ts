import { endedSessionReason, getAdminSession, type AdminSession } from './auth';
import { hasAnyPrivilege, type Privilege } from './privileges';
import { jsonError } from './response';

/** One privilege, any of a list, or the system administrator only. */
export type AdminNeed = Privilege | Privilege[] | 'SYSTEM';

/**
 * Admin-only API guard. Returns the admin session or a ready 401/403 response.
 * Teachers have no admin cookie (separate cookie + role claim), so a teacher
 * session can never satisfy this, whatever it sends.
 * A privilege argument is checked on the loaded admin row (SYSTEM always passes).
 */
export async function requireAdminApi(need?: AdminNeed): Promise<
  { admin: AdminSession; res?: undefined } | { admin?: undefined; res: Response }
> {
  const admin = await getAdminSession();
  if (!admin) return { res: jsonError('Admin sign-in required', 401, { reason: await endedSessionReason() }) };
  if (need === 'SYSTEM' && admin.kind !== 'SYSTEM') {
    return { res: jsonError('Only the system administrator can do that', 403) };
  }
  if (need && need !== 'SYSTEM') {
    const list = Array.isArray(need) ? need : [need];
    if (!hasAnyPrivilege(admin.privileges, admin.kind, list)) {
      return { res: jsonError('You do not have permission for that', 403) };
    }
  }
  return { admin };
}

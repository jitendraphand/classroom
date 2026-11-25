import { endedSessionReason, getAdminSession, type AdminSession } from './auth';
import { hasAnyPrivilege, type Privilege, type PrivilegeSet } from './privileges';
import { jsonError } from './response';

/** One privilege, any of a list, or the system administrator only. */
export type AdminNeed = Privilege | Privilege[] | 'SYSTEM';

/** Pure check used by requireAdminApi and tests. A full-privilege SUB still fails 'SYSTEM'. */
export function adminApiDenied(
  admin: { kind: string; privileges: PrivilegeSet } | null,
  need?: AdminNeed
): { status: 401 | 403; error: string } | null {
  if (!admin) return { status: 401, error: 'Admin sign-in required' };
  if (need === 'SYSTEM' && admin.kind !== 'SYSTEM') {
    return { status: 403, error: 'Only the system administrator can do that' };
  }
  if (need && need !== 'SYSTEM') {
    const list = Array.isArray(need) ? need : [need];
    if (!hasAnyPrivilege(admin.privileges, admin.kind, list)) {
      return { status: 403, error: 'You do not have permission for that' };
    }
  }
  return null;
}

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
  const denied = adminApiDenied(admin, need);
  if (denied) {
    if (denied.status === 401) {
      return { res: jsonError(denied.error, 401, { reason: await endedSessionReason() }) };
    }
    return { res: jsonError(denied.error, denied.status) };
  }
  return { admin: admin! };
}

/**
 * Client-side helpers for "one active session per teacher/admin". Pure (no
 * React / Next imports) so the wording and URL rules are unit-tested.
 */

export type EndedReason = 'signed_in_elsewhere' | 'revoked' | 'disabled' | 'expired' | 'signed_out';

const REASONS: readonly EndedReason[] = ['signed_in_elsewhere', 'revoked', 'disabled', 'expired', 'signed_out'];

export function isEndedReason(v: unknown): v is EndedReason {
  return typeof v === 'string' && (REASONS as readonly string[]).includes(v);
}

/** Fired on window when this tab's staff session ended; open class / viewer connections disconnect. */
export const SESSION_ENDED_EVENT = 'classroom:session-ended';
/** Ask the SessionGuard to re-check the session now (e.g. after an unexplained LiveKit removal). */
export const SESSION_CHECK_EVENT = 'classroom:session-check';

export function endedSessionCopy(reason: EndedReason): { title: string; body: string } {
  switch (reason) {
    case 'signed_in_elsewhere':
      return {
        title: 'You were signed in on another device',
        body: 'Your account was just signed in on another device or browser, so it was signed out here. Only one device can be signed in at a time.',
      };
    case 'revoked':
      return {
        title: 'Your password was changed',
        body: 'Your password was changed or reset, so every device was signed out. Sign in again with the new password.',
      };
    case 'disabled':
      return {
        title: 'Your account was disabled',
        body: 'This account has been disabled. Contact the school administrator.',
      };
    case 'signed_out':
      return { title: 'You were signed out', body: 'This account was signed out. Sign in again to continue.' };
    case 'expired':
    default:
      return { title: 'Please sign in again', body: 'For security, sign in again to continue.' };
  }
}

/** Only same-site relative paths (never `//host` or a scheme) may be used as a post-login target. */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null;
  if (next.startsWith('/login')) return null;
  return next;
}

export function loginHref(reason?: unknown, next?: string | null): string {
  const q = new URLSearchParams();
  if (isEndedReason(reason)) q.set('reason', reason);
  const n = safeNextPath(next);
  if (n) q.set('next', n);
  const s = q.toString();
  return s ? `/login?${s}` : '/login';
}

/** Should a 401 from this request make the guard check the session? Same-origin app APIs only. */
export function shouldCheckAfter401(url: string, origin: string): boolean {
  let u: URL;
  try {
    u = new URL(url, origin);
  } catch {
    return false;
  }
  if (u.origin !== origin || !u.pathname.startsWith('/api/')) return false;
  return !u.pathname.startsWith('/api/auth/login') && !u.pathname.startsWith('/api/auth/status');
}

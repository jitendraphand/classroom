import { SignJWT, jwtVerify } from 'jose';

/**
 * App session JWTs (HS256 with NEXTAUTH_SECRET). Pure: no Next.js / Prisma
 * imports, so the role separation is unit-tested.
 *
 * Each role has its own cookie AND its own `role` claim; a token is only ever
 * accepted for the role it was minted for, so an admin cookie value pasted
 * into the teacher cookie (or vice versa) is rejected. `sv` (session version)
 * is compared to the DB row so a password reset / disable kills old sessions.
 */
export type SessionRole = 'admin' | 'teacher' | 'pupil';

export type SessionClaims = { sub: string; role: SessionRole; sv: number; [k: string]: unknown };

const TTL: Record<SessionRole, string> = {
  admin: '12h',
  teacher: '7d',
  pupil: '12h',
};

export function sessionSecret(raw = process.env.NEXTAUTH_SECRET): Uint8Array {
  if (!raw) throw new Error('NEXTAUTH_SECRET is not set');
  return new TextEncoder().encode(raw);
}

export async function signSession(
  role: SessionRole,
  sub: string,
  sv: number,
  extra: Record<string, unknown> = {},
  secret = sessionSecret()
): Promise<string> {
  return new SignJWT({ ...extra, role, sv })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(TTL[role])
    .sign(secret);
}

/** Verified claims, or null if the token is invalid, expired or for another role. */
export async function verifySession(
  token: string | undefined | null,
  role: SessionRole,
  secret = sessionSecret()
): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    if (payload.role !== role || typeof payload.sub !== 'string') return null;
    // Tokens minted before session versions existed carry no `sv`: treat as 0.
    const sv = typeof payload.sv === 'number' ? payload.sv : 0;
    return { ...payload, sub: payload.sub, role, sv } as SessionClaims;
  } catch {
    return null;
  }
}

/** DB-side checks shared by admin and teacher sessions. */
export function sessionStillValid(
  claims: Pick<SessionClaims, 'sv'>,
  row: { sessionVersion: number; disabled?: boolean } | null
): boolean {
  if (!row) return false;
  if (row.disabled) return false;
  return row.sessionVersion === claims.sv;
}

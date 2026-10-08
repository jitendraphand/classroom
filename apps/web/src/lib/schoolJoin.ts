/**
 * School-app join links: mode switch + unsigned (plain-parameter) parsing.
 * Pure apart from injected deps, so every path is unit-tested.
 *
 * SCHOOL_JOIN_MODE=unsigned (default):
 *   /join?FirstName=Arohi&LastName=Patil&SID=GOS000123&Grade=7&Division=Mahaveer&Campus=CC
 *   Campus is optional: without it the school's only campus is used (see
 *   lib/campusLogic.ts resolveJoinCampus).
 *   No signature, no expiry, no single-use check. Anyone who knows (or guesses)
 *   a student's SID and class can open the class as that student — see
 *   docs/SCHOOL_APP_INTEGRATION.md "Unsigned mode". A signed `t=<JWT>` link is
 *   still accepted when a JWT key/issuer is configured.
 * SCHOOL_JOIN_MODE=signed:
 *   only /join?t=<JWT> (lib/schoolJwt.ts); plain parameters are refused.
 */
import { ALL_DIVISIONS, MAX_CAMPUS_LENGTH, MAX_DIVISION_LENGTH, normalizeCampus, normalizeDivision, normalizeGrade } from './grades';
import { hasUnsignedJoinParams, readUnsignedFields, type UnsignedFields } from './joinParams';
import { JoinTokenError, verifySchoolJoinToken, type JoinClaims, type SchoolJwtConfig } from './schoolJwt';

export { hasUnsignedJoinParams, readUnsignedFields, type UnsignedFields };

export type SchoolJoinMode = 'unsigned' | 'signed';

export function schoolJoinModeFromEnv(env: Record<string, string | undefined> = process.env): SchoolJoinMode {
  return env.SCHOOL_JOIN_MODE?.trim().toLowerCase() === 'signed' ? 'signed' : 'unsigned';
}

export const UNSIGNED_LIMITS = { sid: 64, firstName: 50, lastName: 50, grade: 16, division: MAX_DIVISION_LENGTH, campus: MAX_CAMPUS_LENGTH, roll: 20 };
const SID_RE = /^[A-Za-z0-9._:@/-]+$/;
const NAME_RE = /^[\p{L}\p{M}\p{N} .'’-]+$/u;
const GRADE_RE = /^[A-Za-z0-9 .-]+$/;
const DIVISION_RE = /^[\p{L}\p{N} .:-]+$/u;

/** Validate unsigned fields into the same claims shape the JWT path produces. */
export function validateUnsignedJoin(f: UnsignedFields): JoinClaims {
  for (const k of ['sid', 'firstName', 'grade', 'division'] as const) {
    if (!f[k]) throw new JoinTokenError('missing_details', k);
  }
  const check = (k: keyof typeof UNSIGNED_LIMITS, re: RegExp) => {
    const v = f[k];
    if (v && (v.length > UNSIGNED_LIMITS[k] || !re.test(v))) throw new JoinTokenError('invalid_details', k);
  };
  check('sid', SID_RE);
  check('firstName', NAME_RE);
  check('lastName', NAME_RE);
  check('grade', GRADE_RE);
  check('division', DIVISION_RE);
  check('campus', /^[\p{L}\p{N} .:-]+$/u);
  check('roll', /^[A-Za-z0-9 ./-]+$/);
  const grade = normalizeGrade(f.grade);
  const division = normalizeDivision(f.division);
  if (!grade) throw new JoinTokenError('invalid_details', 'grade');
  if (!division || division === ALL_DIVISIONS) throw new JoinTokenError('invalid_details', 'division');
  return {
    studentId: f.sid!,
    name: [f.firstName, f.lastName].filter(Boolean).join(' '),
    grade,
    division,
    campus: f.campus ? normalizeCampus(f.campus) || null : null,
    rollNumber: f.roll || null,
    email: null,
    phone: null,
    jti: '',
    iat: 0,
    exp: 0,
    issuer: 'unsigned',
  };
}

/** Is a signed-link verifier configured (issuer + key or secret)? */
export function jwtConfigured(cfg: SchoolJwtConfig) {
  return !!cfg.issuer && !!(cfg.publicKeyPem || cfg.secret);
}

/**
 * Decide and validate a /join request.
 * - `t` present: a signed JWT (signed mode always; unsigned mode only when a
 *   JWT key is configured, otherwise `t` is not accepted).
 * - plain fields: unsigned mode only.
 */
export async function resolveSchoolJoin(
  params: URLSearchParams,
  deps: {
    mode: SchoolJoinMode;
    jwt: SchoolJwtConfig;
    claimJti: (key: string, ttlSeconds: number) => Promise<boolean>;
    now?: Date;
  }
): Promise<{ claims: JoinClaims; signed: boolean }> {
  const token = params.get('t');
  if (token) {
    if (deps.mode === 'unsigned' && !jwtConfigured(deps.jwt)) throw new JoinTokenError('not_configured', 'no JWT key');
    return { claims: await verifySchoolJoinToken(token, deps.jwt, deps.claimJti, deps.now), signed: true };
  }
  if (hasUnsignedJoinParams(params)) {
    if (deps.mode !== 'unsigned') throw new JoinTokenError('unsigned_disabled');
    return { claims: validateUnsignedJoin(readUnsignedFields(params)), signed: false };
  }
  throw new JoinTokenError('missing');
}

/** Fields that may be named on the error page. */
export const ERROR_FIELDS: Record<string, string> = {
  sid: 'student ID (SID)',
  firstName: 'first name',
  lastName: 'last name',
  grade: 'grade',
  division: 'division',
  campus: 'campus',
  roll: 'roll number',
};

/**
 * Per-IP fixed window for /join (no secrets needed). Generous by default
 * because a whole school can sit behind one NAT address. Fails open.
 */
export async function joinRateLimited(
  ip: string,
  redis: { incr: (k: string) => Promise<number>; expire: (k: string, s: number) => Promise<unknown> },
  limitPerMinute: number
): Promise<boolean> {
  if (limitPerMinute <= 0) return false;
  try {
    const key = `ratelimit:join:ip:${ip}`;
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, 60);
    return n > limitPerMinute;
  } catch {
    return false;
  }
}

export function joinRateLimitFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.JOIN_RATE_LIMIT_PER_MINUTE);
  return Number.isFinite(n) && env.JOIN_RATE_LIMIT_PER_MINUTE?.trim() ? Math.max(0, Math.floor(n)) : 120;
}

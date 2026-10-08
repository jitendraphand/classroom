/**
 * Verification of the signed join token minted by the external school app's
 * backend (GET /join?t=<jwt>). Pure apart from the injected single-use (jti)
 * store, so every rejection path is unit-tested.
 *
 * Keys: SCHOOL_APP_JWT_PUBLIC_KEY (PEM SPKI; EdDSA/Ed25519 or RS256) is
 * preferred. Only when no public key is configured is the HS256 shared secret
 * SCHOOL_APP_JWT_SECRET used. Never both: a configured public key disables
 * HS256 entirely (no algorithm confusion, no weaker fallback).
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { decodeProtectedHeader, errors as joseErrors, importSPKI, jwtVerify, type KeyLike } from 'jose';
import { normalizeCampus, normalizeDivision, normalizeGrade, ALL_DIVISIONS } from './grades';

export type JoinErrorCode =
  | 'not_configured'
  | 'missing'
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'lifetime_too_long'
  | 'replayed'
  | 'bad_claims'
  | 'unavailable'
  // Unsigned (plain-parameter) links, see lib/schoolJoin.ts.
  | 'missing_details'
  | 'invalid_details'
  | 'unsigned_disabled'
  // No Campus in the link and the school has several (or no) campuses.
  | 'campus_required'
  | 'rate_limited';

export class JoinTokenError extends Error {
  constructor(public code: JoinErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type SchoolJwtConfig = {
  publicKeyPem?: string | null;
  secret?: string | null;
  issuer?: string | null;
  audience: string;
  /** exp − iat may not exceed this. */
  maxLifetimeSeconds: number;
  clockSkewSeconds: number;
};

export type JoinClaims = {
  studentId: string;
  name: string;
  grade: string;
  division: string;
  /** Canonical campus, or null when the link has none (the school's only campus is used). */
  campus: string | null;
  rollNumber: string | null;
  email: string | null;
  phone: string | null;
  jti: string;
  iat: number;
  exp: number;
  issuer: string;
};

const ASYMMETRIC_ALGS = ['EdDSA', 'RS256'] as const;

function pemFromEnv(env: NodeJS.ProcessEnv): string | null {
  const file = env.SCHOOL_APP_JWT_PUBLIC_KEY_FILE?.trim();
  if (file) return readFileSync(file, 'utf8');
  const raw = env.SCHOOL_APP_JWT_PUBLIC_KEY?.trim();
  if (!raw) return null;
  // .env files cannot hold multi-line values portably: accept "\n" escapes.
  return raw.replace(/\\n/g, '\n');
}

export function schoolJwtConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SchoolJwtConfig {
  const n = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    publicKeyPem: pemFromEnv(env),
    secret: env.SCHOOL_APP_JWT_SECRET?.trim() || null,
    issuer: env.SCHOOL_APP_JWT_ISSUER?.trim() || null,
    audience: env.SCHOOL_APP_JWT_AUDIENCE?.trim() || 'classroom',
    maxLifetimeSeconds: Math.min(600, Math.max(10, n(env.SCHOOL_APP_JWT_MAX_LIFETIME_SECONDS, 120))),
    clockSkewSeconds: Math.min(120, Math.max(0, n(env.SCHOOL_APP_JWT_CLOCK_SKEW_SECONDS, 30))),
  };
}

const keyCache = new Map<string, KeyLike>();
async function publicKey(pem: string, alg: string): Promise<KeyLike> {
  const k = `${alg}\n${pem}`;
  let key = keyCache.get(k);
  if (!key) {
    key = (await importSPKI(pem, alg)) as KeyLike;
    keyCache.set(k, key);
  }
  return key;
}

function str(v: unknown, max: number): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/\s+/g, ' ');
  if (!s || s.length > max) return null;
  return s;
}

/**
 * Verify a join token. `claimJti(key, ttlSeconds)` must atomically record the
 * id and return false if it was already used (Redis SET NX EX in production).
 */
export async function verifySchoolJoinToken(
  token: string | null | undefined,
  cfg: SchoolJwtConfig,
  claimJti: (key: string, ttlSeconds: number) => Promise<boolean>,
  now: Date = new Date()
): Promise<JoinClaims> {
  if (!cfg.issuer || (!cfg.publicKeyPem && !cfg.secret)) throw new JoinTokenError('not_configured');
  if (!token) throw new JoinTokenError('missing');
  if (token.length > 4096 || token.split('.').length !== 3) throw new JoinTokenError('malformed');

  let alg: string | undefined;
  try {
    alg = decodeProtectedHeader(token).alg;
  } catch {
    throw new JoinTokenError('malformed');
  }

  let key: KeyLike | Uint8Array;
  let algorithms: string[];
  if (cfg.publicKeyPem) {
    if (!alg || !(ASYMMETRIC_ALGS as readonly string[]).includes(alg)) {
      throw new JoinTokenError('bad_signature', `alg ${alg} not accepted`);
    }
    try {
      key = await publicKey(cfg.publicKeyPem, alg);
    } catch {
      // Configured key does not fit this algorithm (e.g. RSA key, EdDSA token).
      throw new JoinTokenError('bad_signature', 'key/alg mismatch');
    }
    algorithms = [alg];
  } else {
    if (alg !== 'HS256') throw new JoinTokenError('bad_signature', `alg ${alg} not accepted`);
    key = new TextEncoder().encode(cfg.secret!);
    algorithms = ['HS256'];
  }

  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, key, {
      algorithms,
      issuer: cfg.issuer,
      audience: cfg.audience,
      clockTolerance: cfg.clockSkewSeconds,
      currentDate: now,
      requiredClaims: ['exp', 'iat', 'jti'],
    }));
  } catch (e) {
    if (e instanceof joseErrors.JWTExpired) throw new JoinTokenError('expired');
    if (e instanceof joseErrors.JWSSignatureVerificationFailed) throw new JoinTokenError('bad_signature');
    if (e instanceof joseErrors.JOSEAlgNotAllowed) throw new JoinTokenError('bad_signature');
    if (e instanceof joseErrors.JWTClaimValidationFailed) {
      if (e.claim === 'iss') throw new JoinTokenError('wrong_issuer');
      if (e.claim === 'aud') throw new JoinTokenError('wrong_audience');
      if (e.claim === 'nbf' || e.claim === 'iat') throw new JoinTokenError('not_yet_valid');
      throw new JoinTokenError('bad_claims', e.claim);
    }
    if (e instanceof joseErrors.JWSInvalid || e instanceof joseErrors.JWTInvalid) throw new JoinTokenError('malformed');
    // Anything else (key unusable for this token, unsupported key type…): cannot be verified.
    throw new JoinTokenError('bad_signature');
  }

  const nowS = Math.floor(now.getTime() / 1000);
  const iat = payload.iat as number;
  const exp = payload.exp as number;
  if (typeof iat !== 'number' || typeof exp !== 'number') throw new JoinTokenError('bad_claims', 'iat/exp');
  if (iat > nowS + cfg.clockSkewSeconds) throw new JoinTokenError('not_yet_valid');
  if (exp - iat > cfg.maxLifetimeSeconds) throw new JoinTokenError('lifetime_too_long');
  if (exp <= iat) throw new JoinTokenError('bad_claims', 'exp before iat');

  const studentId = str(payload.studentId ?? payload.sub, 64);
  const name = str(payload.name, 100);
  const grade = normalizeGrade(str(payload.grade, 32) ?? '');
  const division = normalizeDivision(str(payload.division, 32) ?? '');
  const jti = str(payload.jti, 128);
  if (!studentId || !/^[A-Za-z0-9._:@/-]+$/.test(studentId)) throw new JoinTokenError('bad_claims', 'studentId');
  if (payload.studentId != null && payload.sub != null && String(payload.studentId) !== String(payload.sub)) {
    throw new JoinTokenError('bad_claims', 'sub and studentId differ');
  }
  if (!name) throw new JoinTokenError('bad_claims', 'name');
  if (!grade) throw new JoinTokenError('bad_claims', 'grade');
  if (!division || division === ALL_DIVISIONS) throw new JoinTokenError('bad_claims', 'division');
  if (!jti || jti.length < 8) throw new JoinTokenError('bad_claims', 'jti');

  // Single use: remembered until the token could no longer be accepted anyway.
  const ttl = Math.max(1, exp - nowS + cfg.clockSkewSeconds);
  const jtiKey = createHash('sha256').update(`${cfg.issuer}\n${jti}`).digest('hex');
  let fresh: boolean;
  try {
    fresh = await claimJti(jtiKey, ttl);
  } catch {
    throw new JoinTokenError('unavailable');
  }
  if (!fresh) throw new JoinTokenError('replayed');

  return {
    studentId,
    name,
    grade,
    division,
    campus: normalizeCampus(str(payload.campus, 32) ?? '') || null,
    rollNumber: str(payload.rollNumber ?? payload.roll ?? payload.roll_no, 20),
    email: str(payload.email, 200),
    phone: str(payload.phone, 32),
    jti,
    iat,
    exp,
    issuer: cfg.issuer,
  };
}

/** Student-facing text for each failure. */
export const JOIN_ERROR_TEXT: Record<JoinErrorCode, { title: string; body: string }> = {
  not_configured: {
    title: 'Joining is not set up yet',
    body: 'The classroom has not been connected to the school app. Please tell your school.',
  },
  missing: { title: 'Open this from the school app', body: 'Tap "Join class" in the school app to come here.' },
  malformed: { title: 'This link is not valid', body: 'Go back to the school app and tap "Join class" again.' },
  bad_signature: { title: 'This link is not valid', body: 'Go back to the school app and tap "Join class" again.' },
  expired: {
    title: 'This link has expired',
    body: 'Join links work for a short time only. Go back to the school app and tap "Join class" again.',
  },
  not_yet_valid: {
    title: 'Check your device clock',
    body: 'Your link is not valid yet. Make sure the date and time on your device are correct, then try again from the school app.',
  },
  wrong_issuer: { title: 'This link is not valid', body: 'Go back to the school app and tap "Join class" again.' },
  wrong_audience: { title: 'This link is not for this classroom', body: 'Go back to the school app and tap "Join class" again.' },
  lifetime_too_long: { title: 'This link is not valid', body: 'Go back to the school app and tap "Join class" again.' },
  replayed: {
    title: 'This link was already used',
    body: 'Each join link works once. Go back to the school app and tap "Join class" again.',
  },
  bad_claims: {
    title: 'Your details are incomplete',
    body: 'The school app did not send your class details. Please tell your school.',
  },
  unavailable: { title: 'Please try again', body: 'The classroom is busy right now. Wait a moment and try again from the school app.' },
  missing_details: {
    title: 'Your details are incomplete',
    body: 'The school app link is missing your student ID, name, grade or division. Please tell your school.',
  },
  invalid_details: {
    title: 'Your details could not be read',
    body: 'The school app link has a value the classroom cannot accept. Please tell your school.',
  },
  campus_required: {
    title: 'Your campus is missing',
    body: 'The school app link does not say which campus you are in. Please tell your school.',
  },
  unsigned_disabled: {
    title: 'This link is not valid',
    body: 'This classroom only accepts secure links from the school app. Go back to the school app and tap "Join class" again.',
  },
  rate_limited: {
    title: 'Too many attempts',
    body: 'Too many join attempts came from this network. Wait a minute and try again from the school app.',
  },
};

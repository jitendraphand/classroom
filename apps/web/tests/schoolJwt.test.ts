import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { JoinTokenError, schoolJwtConfigFromEnv, verifySchoolJoinToken, type SchoolJwtConfig } from '../src/lib/schoolJwt';

const SECRET = 'test-shared-secret-0123456789abcdef0123456789';
const NOW = new Date('2026-10-01T04:00:00Z');
const nowS = Math.floor(NOW.getTime() / 1000);

const ed = generateKeyPairSync('ed25519');
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherEd = generateKeyPairSync('ed25519');
const edPub = ed.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const rsaPub = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const hsCfg: SchoolJwtConfig = { secret: SECRET, issuer: 'school-app', audience: 'classroom', maxLifetimeSeconds: 120, clockSkewSeconds: 30 };
const edCfg: SchoolJwtConfig = { ...hsCfg, secret: null, publicKeyPem: edPub };

type Opts = {
  alg?: string;
  key?: unknown;
  iss?: string;
  aud?: string;
  iat?: number;
  exp?: number;
  jti?: string | null;
  claims?: Record<string, unknown>;
};

async function sign(o: Opts = {}) {
  const alg = o.alg ?? 'HS256';
  const key = o.key ?? new TextEncoder().encode(SECRET);
  let j = new SignJWT({ sub: 'S1001', name: 'Asha  Patil', grade: ' 7 ', division: 'b', rollNumber: 12, ...o.claims })
    .setProtectedHeader({ alg })
    .setIssuer(o.iss ?? 'school-app')
    .setAudience(o.aud ?? 'classroom')
    .setIssuedAt(o.iat ?? nowS - 5)
    .setExpirationTime(o.exp ?? nowS + 55);
  if (o.jti !== null) j = j.setJti(o.jti ?? randomUUID());
  return j.sign(key as Uint8Array);
}

function memoryStore() {
  const seen = new Map<string, number>();
  return async (k: string, ttl: number) => {
    if (seen.has(k)) return false;
    seen.set(k, ttl);
    return true;
  };
}

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof JoinTokenError && e.code === code);
}

test('schoolJwt: valid HS256 token gives normalised claims', async () => {
  const c = await verifySchoolJoinToken(await sign(), hsCfg, memoryStore(), NOW);
  assert.equal(c.studentId, 'S1001');
  assert.equal(c.name, 'Asha Patil');
  assert.equal(c.grade, '7');
  assert.equal(c.division, 'B');
  assert.equal(c.rollNumber, '12');
});

test('schoolJwt: EdDSA and RS256 public keys', async () => {
  const c = await verifySchoolJoinToken(await sign({ alg: 'EdDSA', key: ed.privateKey }), edCfg, memoryStore(), NOW);
  assert.equal(c.studentId, 'S1001');
  const rsCfg = { ...edCfg, publicKeyPem: rsaPub };
  const r = await verifySchoolJoinToken(await sign({ alg: 'RS256', key: rsa.privateKey }), rsCfg, memoryStore(), NOW);
  assert.equal(r.division, 'B');
});

test('schoolJwt: expired token', async () => {
  await rejects(verifySchoolJoinToken(await sign({ iat: nowS - 200, exp: nowS - 100 }), hsCfg, memoryStore(), NOW), 'expired');
});

test('schoolJwt: bad signature (wrong secret / wrong key / tampered)', async () => {
  await rejects(
    verifySchoolJoinToken(await sign({ key: new TextEncoder().encode('another-secret-another-secret-xx') }), hsCfg, memoryStore(), NOW),
    'bad_signature'
  );
  await rejects(verifySchoolJoinToken(await sign({ alg: 'EdDSA', key: otherEd.privateKey }), edCfg, memoryStore(), NOW), 'bad_signature');
  const good = await sign();
  const [h, , s] = good.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'S9', name: 'X', grade: '7', division: 'A', iss: 'school-app', aud: 'classroom', iat: nowS, exp: nowS + 50, jti: 'abcdefgh1' })).toString('base64url');
  await rejects(verifySchoolJoinToken(`${h}.${forged}.${s}`, hsCfg, memoryStore(), NOW), 'bad_signature');
});

test('schoolJwt: HS256 refused when a public key is configured; alg none refused', async () => {
  const both = { ...edCfg, secret: SECRET };
  await rejects(verifySchoolJoinToken(await sign(), both, memoryStore(), NOW), 'bad_signature');
  const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"S1"}').toString('base64url')}.`;
  await rejects(verifySchoolJoinToken(none, hsCfg, memoryStore(), NOW), 'bad_signature');
  // RSA token against an Ed25519 key.
  await rejects(verifySchoolJoinToken(await sign({ alg: 'RS256', key: rsa.privateKey }), edCfg, memoryStore(), NOW), 'bad_signature');
});

test('schoolJwt: wrong audience / issuer', async () => {
  await rejects(verifySchoolJoinToken(await sign({ aud: 'other' }), hsCfg, memoryStore(), NOW), 'wrong_audience');
  await rejects(verifySchoolJoinToken(await sign({ iss: 'evil' }), hsCfg, memoryStore(), NOW), 'wrong_issuer');
});

test('schoolJwt: lifetime longer than the maximum is rejected', async () => {
  await rejects(verifySchoolJoinToken(await sign({ iat: nowS - 10, exp: nowS + 3600 }), hsCfg, memoryStore(), NOW), 'lifetime_too_long');
  // exactly the maximum is fine
  await verifySchoolJoinToken(await sign({ iat: nowS - 10, exp: nowS + 110 }), hsCfg, memoryStore(), NOW);
});

test('schoolJwt: iat in the future beyond skew', async () => {
  await rejects(verifySchoolJoinToken(await sign({ iat: nowS + 300, exp: nowS + 360 }), hsCfg, memoryStore(), NOW), 'not_yet_valid');
});

test('schoolJwt: replayed jti is rejected, and jti is required', async () => {
  const store = memoryStore();
  const t = await sign({ jti: 'fixed-jti-123' });
  await verifySchoolJoinToken(t, hsCfg, store, NOW);
  await rejects(verifySchoolJoinToken(t, hsCfg, store, NOW), 'replayed');
  await rejects(verifySchoolJoinToken(await sign({ jti: null }), hsCfg, memoryStore(), NOW), 'bad_claims');
});

test('schoolJwt: jti TTL covers the remaining lifetime', async () => {
  let ttlSeen = 0;
  await verifySchoolJoinToken(await sign(), hsCfg, async (_k, ttl) => ((ttlSeen = ttl), true), NOW);
  assert.ok(ttlSeen >= 55 && ttlSeen <= 120, String(ttlSeen));
});

test('schoolJwt: missing claims, store down, not configured', async () => {
  await rejects(verifySchoolJoinToken(await sign({ claims: { grade: '' } }), hsCfg, memoryStore(), NOW), 'bad_claims');
  await rejects(verifySchoolJoinToken(await sign({ claims: { division: '*' } }), hsCfg, memoryStore(), NOW), 'bad_claims');
  await rejects(verifySchoolJoinToken(await sign({ claims: { studentId: 'S2' } }), hsCfg, memoryStore(), NOW), 'bad_claims');
  await rejects(
    verifySchoolJoinToken(await sign(), hsCfg, async () => {
      throw new Error('redis down');
    }, NOW),
    'unavailable'
  );
  await rejects(verifySchoolJoinToken(await sign(), { ...hsCfg, issuer: null }, memoryStore(), NOW), 'not_configured');
  await rejects(verifySchoolJoinToken('', hsCfg, memoryStore(), NOW), 'missing');
  await rejects(verifySchoolJoinToken('abc', hsCfg, memoryStore(), NOW), 'malformed');
});

test('schoolJwt: env config parses escaped PEM and bounds', () => {
  const cfg = schoolJwtConfigFromEnv({
    SCHOOL_APP_JWT_PUBLIC_KEY: edPub.trim().replace(/\n/g, '\\n'),
    SCHOOL_APP_JWT_ISSUER: 'school-app',
    SCHOOL_APP_JWT_MAX_LIFETIME_SECONDS: '99999',
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(cfg.publicKeyPem, edPub.trim());
  assert.equal(cfg.audience, 'classroom');
  assert.equal(cfg.maxLifetimeSeconds, 600);
});

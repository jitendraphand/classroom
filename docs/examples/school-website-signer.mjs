#!/usr/bin/env node
/**
 * Sample signer for the SCHOOL WEBSITE / school-app backend (not the classroom).
 * Zero dependencies (Node 18+ `node:crypto` only), so it can be copied as is.
 *
 * Mints a one-time, 60-second classroom join link for a signed-in student:
 *   https://<classroom>/join?t=<JWT>
 *
 * Keys (one of):
 *   SCHOOL_SIGNER_PRIVATE_KEY_FILE=school-app-private.pem   Ed25519 (EdDSA, recommended) or RSA (RS256)
 *   SCHOOL_SIGNER_HS256_SECRET=...                          shared secret (fallback; the classroom must
 *                                                            then have SCHOOL_APP_JWT_SECRET and NO public key)
 * Also: SCHOOL_SIGNER_ISSUER (= classroom SCHOOL_APP_JWT_ISSUER),
 *       SCHOOL_SIGNER_AUDIENCE (default "classroom"), CLASSROOM_URL.
 *
 * CLI (for testing):
 *   node school-website-signer.mjs --sid GOS000123 --name "Arohi Patil" --grade 7 --division A [--campus CC] [--roll 12]
 * Library:
 *   import { classroomJoinUrl } from './school-website-signer.mjs';
 *   res.redirect(classroomJoinUrl({ id, name, grade, division, campus }));
 *
 * Rules: sign on the server only, mint a fresh link for every "Join class"
 * tap, never cache or embed tokens, keep the private key out of the app.
 */
import { createHmac, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function signJoinToken(student, opts = {}) {
  const env = process.env;
  const issuer = opts.issuer ?? env.SCHOOL_SIGNER_ISSUER;
  const audience = opts.audience ?? env.SCHOOL_SIGNER_AUDIENCE ?? 'classroom';
  const ttl = Math.min(120, Number(opts.ttlSeconds ?? 60));
  if (!issuer) throw new Error('Set SCHOOL_SIGNER_ISSUER (must equal the classroom SCHOOL_APP_JWT_ISSUER)');
  for (const k of ['id', 'name', 'grade', 'division']) if (!student?.[k]) throw new Error(`student.${k} is required`);

  const keyFile = opts.privateKeyFile ?? env.SCHOOL_SIGNER_PRIVATE_KEY_FILE;
  const secret = opts.secret ?? env.SCHOOL_SIGNER_HS256_SECRET;
  let alg;
  let key;
  if (keyFile || opts.privateKeyPem) {
    key = createPrivateKey(opts.privateKeyPem ?? readFileSync(keyFile, 'utf8'));
    alg = key.asymmetricKeyType === 'ed25519' ? 'EdDSA' : key.asymmetricKeyType === 'rsa' ? 'RS256' : null;
    if (!alg) throw new Error(`Unsupported key type ${key.asymmetricKeyType}; use Ed25519 or RSA`);
  } else if (secret) {
    if (secret.length < 32) throw new Error('HS256 secret must be at least 32 characters');
    alg = 'HS256';
  } else {
    throw new Error('Set SCHOOL_SIGNER_PRIVATE_KEY_FILE (preferred) or SCHOOL_SIGNER_HS256_SECRET');
  }

  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const payload = {
    sub: String(student.id),
    name: String(student.name),
    grade: String(student.grade),
    division: String(student.division),
    ...(student.campus ? { campus: String(student.campus) } : {}),
    ...(student.rollNumber != null && student.rollNumber !== '' ? { rollNumber: String(student.rollNumber) } : {}),
    iss: issuer,
    aud: audience,
    iat: now,
    exp: now + ttl,
    jti: randomUUID(),
  };
  const input = `${b64url(JSON.stringify({ alg, typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}`;
  const sig =
    alg === 'HS256'
      ? createHmac('sha256', secret).update(input).digest()
      : sign(alg === 'EdDSA' ? null : 'sha256', Buffer.from(input), key);
  return `${input}.${b64url(sig)}`;
}

export function classroomJoinUrl(student, opts = {}) {
  const base = (opts.classroomUrl ?? process.env.CLASSROOM_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/join?t=${signJoinToken(student, opts)}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2);
  const o = (n) => {
    const i = a.indexOf(`--${n}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  try {
    console.log(
      classroomJoinUrl({ id: o('sid'), name: o('name'), grade: o('grade'), division: o('division'), campus: o('campus'), rollNumber: o('roll') })
    );
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

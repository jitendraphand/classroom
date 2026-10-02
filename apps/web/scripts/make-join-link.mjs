#!/usr/bin/env node
/**
 * Dev/test helper: mint a school-app join link exactly like the external
 * school app's backend would. NOT for production use: the real tokens must be
 * minted by the school app's server.
 *
 *   node scripts/make-join-link.mjs --gen-keys ./tmp-keys     # Ed25519 test key pair
 *   node scripts/make-join-link.mjs --key ./tmp-keys/private.pem \
 *        --student S1001 --name "Asha Patil" --grade 7 --division A --roll 12
 *   SCHOOL_APP_JWT_SECRET=... node scripts/make-join-link.mjs --student S1001 ...   # HS256
 *
 *   # Unsigned mode (SCHOOL_JOIN_MODE=unsigned): plain parameters, no key needed
 *   node scripts/make-join-link.mjs --unsigned --student GOS000123 \
 *        --first Arohi --last Patil --grade 7 --division Mahaveer
 *
 * Options: --url (APP_URL, default http://localhost:3000), --iss
 * (SCHOOL_APP_JWT_ISSUER), --aud (SCHOOL_APP_JWT_AUDIENCE or "classroom"),
 * --ttl seconds (default 60), --alg (EdDSA|RS256, inferred from the key).
 */
import { generateKeyPairSync, randomUUID, createPrivateKey } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SignJWT } from 'jose';

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(0);
}

if (args.includes('--gen-keys')) {
  const dir = opt('gen-keys', './join-test-keys');
  const type = (opt('alg', 'EdDSA') === 'RS256') ? 'rsa' : 'ed25519';
  const { publicKey, privateKey } =
    type === 'rsa' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ed25519');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  writeFileSync(join(dir, 'private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(join(dir, 'public.pem'), pub, { mode: 0o644 });
  console.log(`Wrote ${dir}/private.pem (keep secret) and ${dir}/public.pem (${type}).`);
  console.log('For the classroom .env (one line):');
  console.log(`SCHOOL_APP_JWT_PUBLIC_KEY="${String(pub).trim().replace(/\n/g, '\\n')}"`);
  process.exit(0);
}

if (args.includes('--unsigned')) {
  const base = (opt('url', process.env.APP_URL || 'http://localhost:3000')).replace(/\/$/, '');
  let first = opt('first');
  let last = opt('last');
  if (!first && opt('name')) [first, last] = [opt('name').split(' ')[0], opt('name').split(' ').slice(1).join(' ')];
  const q = new URLSearchParams();
  q.set('FirstName', first || die('Pass --first'));
  if (last) q.set('LastName', last);
  q.set('SID', opt('student') || die('Pass --student <SID>'));
  q.set('Grade', opt('grade') || die('Pass --grade'));
  q.set('Division', opt('division') || die('Pass --division'));
  console.log(`${base}/join?${q.toString()}`);
  process.exit(0);
}

const iss = opt('iss', process.env.SCHOOL_APP_JWT_ISSUER) || die('Pass --iss or set SCHOOL_APP_JWT_ISSUER');
const aud = opt('aud', process.env.SCHOOL_APP_JWT_AUDIENCE || 'classroom');
const base = (opt('url', process.env.APP_URL || 'http://localhost:3000')).replace(/\/$/, '');
const ttl = Number(opt('ttl', '60'));
const student = opt('student') || die('Pass --student <id>');
const claims = {
  sub: student,
  name: opt('name') || die('Pass --name'),
  grade: opt('grade') || die('Pass --grade'),
  division: opt('division') || die('Pass --division'),
};
const roll = opt('roll');
if (roll) claims.rollNumber = roll;

let key;
let alg;
const keyFile = opt('key');
if (keyFile) {
  key = createPrivateKey(readFileSync(keyFile));
  alg = opt('alg', key.asymmetricKeyType === 'rsa' ? 'RS256' : 'EdDSA');
} else if (process.env.SCHOOL_APP_JWT_SECRET) {
  key = new TextEncoder().encode(process.env.SCHOOL_APP_JWT_SECRET);
  alg = 'HS256';
} else {
  die('Pass --key private.pem or set SCHOOL_APP_JWT_SECRET');
}

const now = Math.floor(Date.now() / 1000);
const token = await new SignJWT(claims)
  .setProtectedHeader({ alg, typ: 'JWT' })
  .setIssuer(iss)
  .setAudience(aud)
  .setIssuedAt(now)
  .setExpirationTime(now + ttl)
  .setJti(randomUUID())
  .sign(key);

console.log(`${base}/join?t=${token}`);

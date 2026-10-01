import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { SignJWT } from 'jose';
import { signSession, verifySession, sessionStillValid } from '../src/lib/sessionTokens';
import { generatePassword, passwordProblem } from '../src/lib/passwords';

const secret = new TextEncoder().encode('x'.repeat(48));

test('an admin session token verifies only as admin', async () => {
  const t = await signSession('admin', 'a1', 0, {}, secret);
  assert.equal((await verifySession(t, 'admin', secret))?.sub, 'a1');
  assert.equal(await verifySession(t, 'teacher', secret), null);
  assert.equal(await verifySession(t, 'pupil', secret), null);
});

test('a teacher session token can never satisfy the admin guard', async () => {
  const t = await signSession('teacher', 't1', 0, { email: 't@x.org' }, secret);
  assert.equal(await verifySession(t, 'admin', secret), null);
  assert.equal((await verifySession(t, 'teacher', secret))?.sub, 't1');
});

test('a pupil (student) token cannot act as teacher or admin', async () => {
  const t = await signSession('pupil', 's1', 0, {}, secret);
  assert.equal(await verifySession(t, 'teacher', secret), null);
  assert.equal(await verifySession(t, 'admin', secret), null);
});

test('tokens signed with another secret or alg none are rejected', async () => {
  const other = new TextEncoder().encode('y'.repeat(48));
  const t = await signSession('admin', 'a1', 0, {}, other);
  assert.equal(await verifySession(t, 'admin', secret), null);
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ sub: 'a1', role: 'admin', sv: 0 })).toString('base64url');
  assert.equal(await verifySession(`${header}.${body}.`, 'admin', secret), null);
});

test('legacy teacher tokens (no sv) map to session version 0', async () => {
  const legacy = await new SignJWT({ role: 'teacher', email: 'a@b.c' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('t1')
    .setExpirationTime('1h')
    .sign(secret);
  const c = await verifySession(legacy, 'teacher', secret);
  assert.equal(c?.sv, 0);
  assert.equal(sessionStillValid(c!, { sessionVersion: 0 }), true);
});

test('password reset / disable invalidates existing sessions', () => {
  assert.equal(sessionStillValid({ sv: 2 }, { sessionVersion: 2 }), true);
  assert.equal(sessionStillValid({ sv: 2 }, { sessionVersion: 3 }), false);
  assert.equal(sessionStillValid({ sv: 2 }, { sessionVersion: 2, disabled: true }), false);
  assert.equal(sessionStillValid({ sv: 0 }, null), false);
});

test('generated passwords are long, varied and readable', () => {
  const a = generatePassword();
  const b = generatePassword();
  assert.notEqual(a, b);
  assert.equal(a.replace(/-/g, '').length, 20);
  assert.match(a, /^[A-HJ-NP-Za-km-z2-9-]+$/);
  assert.equal(passwordProblem(a), null);
});

test('weak new passwords are refused', () => {
  assert.ok(passwordProblem('short'));
  assert.ok(passwordProblem('aaaaaaaaaaaa'));
  assert.ok(passwordProblem('password123456'));
  assert.ok(passwordProblem('Same-Password-1', { current: 'Same-Password-1' }));
  assert.equal(passwordProblem('correct horse battery'), null);
});

test('public teacher self-registration is removed', () => {
  assert.equal(existsSync(new URL('../src/app/api/auth/register/route.ts', import.meta.url)), false);
});

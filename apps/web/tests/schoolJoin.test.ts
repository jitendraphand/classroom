import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { Student } from '@prisma/client';
import {
  displayDivision,
  formatAssignment,
  formatAudience,
  audienceIncludes,
  canTeachAudience,
  normalizeDivision,
  parseAssignments,
  parseDivisionList,
} from '../src/lib/grades';
import { hasUnsignedJoinParams } from '../src/lib/joinParams';
import { parseRoster } from '../src/lib/roster';
import {
  joinRateLimited,
  joinRateLimitFromEnv,
  resolveSchoolJoin,
  schoolJoinModeFromEnv,
  validateUnsignedJoin,
  readUnsignedFields,
} from '../src/lib/schoolJoin';
import { JoinTokenError, type SchoolJwtConfig } from '../src/lib/schoolJwt';
import { handleStudentCheck, nextPollDelay } from '../src/lib/studentCheck';
import { routeSignature } from '../src/lib/studentRouting';
import { upsertStudentFromClaims } from '../src/lib/studentService';

const CANONICAL = 'FirstName=Arohi&LastName=Patil&SID=GOS000123&Grade=7&Division=Mahaveer';
const noJwt: SchoolJwtConfig = { issuer: null, publicKeyPem: null, secret: null, audience: 'classroom', maxLifetimeSeconds: 120, clockSkewSeconds: 30 };
const SECRET = 'test-shared-secret-0123456789abcdef0123456789';
const hsCfg: SchoolJwtConfig = { ...noJwt, issuer: 'school-app', secret: SECRET };
const neverUsed = async () => true;

async function code(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof JoinTokenError, String(e));
    return { code: e.code, field: e.message.split(': ')[1] };
  }
  assert.fail('expected a JoinTokenError');
}

// ---------------------------------------------------------------- parsing

test('unsigned link: the canonical form is parsed into join claims', async () => {
  const { claims, signed } = await resolveSchoolJoin(new URLSearchParams(CANONICAL), { mode: 'unsigned', jwt: noJwt, claimJti: neverUsed });
  assert.equal(signed, false);
  assert.equal(claims.studentId, 'GOS000123');
  assert.equal(claims.name, 'Arohi Patil');
  assert.equal(claims.grade, '7');
  assert.equal(claims.division, 'MAHAVEER');
  assert.equal(claims.rollNumber, null);
});

test('unsigned link: parameter names are case-insensitive, values URL-decoded and trimmed', () => {
  const p = new URLSearchParams('firstname=%20Arohi%20&LASTNAME=Patil%20%20Desai&sid=GOS000123&grade=Grade%207&DIVISION=%20mahaveer%20');
  assert.equal(hasUnsignedJoinParams(p), true);
  const c = validateUnsignedJoin(readUnsignedFields(p));
  assert.equal(c.name, 'Arohi Patil Desai');
  assert.equal(c.grade, '7');
  assert.equal(c.division, 'MAHAVEER');
  // Unicode names are fine.
  assert.equal(validateUnsignedJoin({ sid: 'S1', firstName: 'Ārohī', grade: '7', division: 'A' }).name, 'Ārohī');
});

test('unsigned link: last name is optional', () => {
  const c = validateUnsignedJoin({ sid: 'S1', firstName: 'Arohi', grade: '7', division: 'B' });
  assert.equal(c.name, 'Arohi');
  assert.equal(c.division, 'B');
});

test('unsigned link: validation errors name the field', async () => {
  const run = (q: string) => code(resolveSchoolJoin(new URLSearchParams(q), { mode: 'unsigned', jwt: noJwt, claimJti: neverUsed }));
  assert.deepEqual(await run('FirstName=A&Grade=7&Division=B'), { code: 'missing_details', field: 'sid' });
  assert.deepEqual(await run('SID=S1&Grade=7&Division=B'), { code: 'missing_details', field: 'firstName' });
  assert.deepEqual(await run('SID=S1&FirstName=A&Division=B'), { code: 'missing_details', field: 'grade' });
  assert.deepEqual(await run('SID=S1&FirstName=A&Grade=7'), { code: 'missing_details', field: 'division' });
  assert.deepEqual(await run('SID=S1&FirstName=A&Grade=7&Division=%20'), { code: 'missing_details', field: 'division' });
  assert.deepEqual(await run('SID=S%201&FirstName=A&Grade=7&Division=B'), { code: 'invalid_details', field: 'sid' });
  assert.deepEqual(await run(`SID=${'X'.repeat(65)}&FirstName=A&Grade=7&Division=B`), { code: 'invalid_details', field: 'sid' });
  assert.deepEqual(await run('SID=S1&FirstName=%3Cscript%3E&Grade=7&Division=B'), { code: 'invalid_details', field: 'firstName' });
  assert.deepEqual(await run(`SID=S1&FirstName=${'a'.repeat(51)}&Grade=7&Division=B`), { code: 'invalid_details', field: 'firstName' });
  assert.deepEqual(await run('SID=S1&FirstName=A&Grade=7&Division=ALL'), { code: 'invalid_details', field: 'division' });
  assert.deepEqual(await run(`SID=S1&FirstName=A&Grade=7&Division=${'m'.repeat(33)}`), { code: 'invalid_details', field: 'division' });
  assert.deepEqual(await run('Grade=7'), { code: 'missing_details', field: 'sid' });
  assert.deepEqual(await run(''), { code: 'missing', field: undefined });
});

// ---------------------------------------------------------------- mode switch

test('mode: unsigned is the default; only "signed" switches it', () => {
  assert.equal(schoolJoinModeFromEnv({}), 'unsigned');
  assert.equal(schoolJoinModeFromEnv({ SCHOOL_JOIN_MODE: 'unsigned' }), 'unsigned');
  assert.equal(schoolJoinModeFromEnv({ SCHOOL_JOIN_MODE: ' Signed ' }), 'signed');
});

test('mode signed: plain-parameter links are refused', async () => {
  const r = await code(resolveSchoolJoin(new URLSearchParams(CANONICAL), { mode: 'signed', jwt: hsCfg, claimJti: neverUsed }));
  assert.equal(r.code, 'unsigned_disabled');
});

test('unsigned mode needs no JWT issuer/key; a t= token is only accepted when a key is configured', async () => {
  await resolveSchoolJoin(new URLSearchParams(CANONICAL), { mode: 'unsigned', jwt: noJwt, claimJti: neverUsed });
  const token = await new SignJWT({ sub: 'S1001', name: 'Asha Patil', grade: '7', division: 'Mahaveer' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('school-app')
    .setAudience('classroom')
    .setIssuedAt()
    .setExpirationTime('60s')
    .setJti(randomUUID())
    .sign(new TextEncoder().encode(SECRET));
  const t = new URLSearchParams({ t: token });
  assert.equal((await code(resolveSchoolJoin(t, { mode: 'unsigned', jwt: noJwt, claimJti: neverUsed }))).code, 'not_configured');
  const viaUnsigned = await resolveSchoolJoin(t, { mode: 'unsigned', jwt: hsCfg, claimJti: neverUsed });
  assert.equal(viaUnsigned.signed, true);
  assert.equal(viaUnsigned.claims.division, 'MAHAVEER'); // word division through the JWT path too
  const viaSigned = await resolveSchoolJoin(t, { mode: 'signed', jwt: hsCfg, claimJti: neverUsed });
  assert.equal(viaSigned.claims.studentId, 'S1001');
});

test('unsigned links have no replay check: the same link works again', async () => {
  let claimed = 0;
  const claimJti = async () => {
    claimed++;
    return false; // would reject a replayed JWT
  };
  for (let i = 0; i < 3; i++) {
    await resolveSchoolJoin(new URLSearchParams(CANONICAL), { mode: 'unsigned', jwt: hsCfg, claimJti });
  }
  assert.equal(claimed, 0);
});

// ---------------------------------------------------------------- student upsert

function memoryDb() {
  const rows = new Map<string, Student>();
  let n = 0;
  return {
    rows,
    student: {
      async upsert(a: { where: { externalId: string }; create: Record<string, unknown> & { externalId: string }; update: Record<string, unknown> }) {
        const cur = rows.get(a.where.externalId);
        const next = (cur ? { ...cur, ...a.update } : { id: `st${++n}`, rollNumber: null, email: null, phone: null, ...a.create }) as Student;
        rows.set(a.where.externalId, next);
        return next;
      },
      async update(a: { where: { externalId: string }; data: Record<string, unknown> }) {
        const next = { ...rows.get(a.where.externalId)!, ...a.data } as Student;
        rows.set(a.where.externalId, next);
        return next;
      },
    },
  };
}

test('first join creates the student keyed on SID; a later join updates name/grade/division', async () => {
  const db = memoryDb();
  const first = await upsertStudentFromClaims({ ...validateUnsignedJoin(readUnsignedFields(new URLSearchParams(CANONICAL + '&Roll=12'))), campus: 'CC' }, db);
  assert.equal(first.externalId, 'GOS000123');
  assert.equal(first.name, 'Arohi Patil');
  assert.equal(first.grade, '7');
  assert.equal(first.division, 'MAHAVEER');
  assert.equal(first.rollNumber, '12');
  assert.equal((first as Student & { source: string }).source, 'join');

  // Promoted: next year's link.
  const later = await upsertStudentFromClaims(
    { ...validateUnsignedJoin(readUnsignedFields(new URLSearchParams('FirstName=Arohi&LastName=Patil-Shah&SID=GOS000123&Grade=8&Division=Shivaji'))), campus: 'CC' },
    db
  );
  assert.equal(db.rows.size, 1);
  assert.equal(later.id, first.id);
  assert.equal(later.name, 'Arohi Patil-Shah');
  assert.equal(later.grade, '8');
  assert.equal(later.division, 'SHIVAJI');
  assert.equal(later.rollNumber, '12', 'a link without a roll number keeps the stored one');
});

// ---------------------------------------------------------------- word divisions

test('word divisions are canonical and matched case-insensitively everywhere', () => {
  assert.equal(normalizeDivision(' mahaveer '), 'MAHAVEER');
  assert.equal(normalizeDivision('MaHaVeEr'), 'MAHAVEER');
  assert.equal(normalizeDivision('Div A'), 'A');
  assert.equal(normalizeDivision('Divya'), 'DIVYA'); // prefix only stripped before a separator
  assert.equal(normalizeDivision('Second'), 'SECOND');
  assert.equal(displayDivision('MAHAVEER'), 'Mahaveer');
  assert.equal(displayDivision('B'), 'B');
  assert.equal(formatAudience('CC', '7', ['MAHAVEER', 'A'], false), 'CC · 7-A, Mahaveer');
  assert.equal(formatAssignment({ campus: 'CC', grade: '7', division: 'MAHAVEER' }), 'CC@7-Mahaveer');
  assert.deepEqual(parseAssignments('7-Mahaveer, 7 shivaji, 8-ALL', 'CC'), [
    { campus: 'CC', grade: '7', division: 'MAHAVEER' },
    { campus: 'CC', grade: '7', division: 'SHIVAJI' },
    { campus: 'CC', grade: '8', division: '*' },
  ]);
  assert.deepEqual(parseDivisionList('Mahaveer, shivaji'), { divisions: ['MAHAVEER', 'SHIVAJI'], allDivisions: false });
  const slot = { campus: 'CC', grade: '7', divisions: parseDivisionList('mahaveer').divisions, allDivisions: false };
  assert.equal(audienceIncludes(slot, { campus: 'CC', grade: '7', division: 'Mahaveer' }), true);
  assert.equal(audienceIncludes(slot, { campus: 'CC', grade: '7', division: 'MAHAVEER' }), true);
  assert.equal(audienceIncludes(slot, { campus: 'CC', grade: '7', division: 'A' }), false);
  assert.equal(canTeachAudience(parseAssignments('7-Mahaveer', 'CC'), 'CC', '7', ['mahaveer'], false), true);
  const roster = parseRoster('externalId,name,grade,division,roll\nGOS000123,Arohi Patil,7,mahaveer,1', [], [], 'CC');
  assert.equal(roster.rows[0]?.division, 'MAHAVEER');
});

// ---------------------------------------------------------------- abuse protection

test('per-IP join rate limit (fixed window, fails open)', async () => {
  const counts = new Map<string, number>();
  const redis = {
    incr: async (k: string) => {
      counts.set(k, (counts.get(k) ?? 0) + 1);
      return counts.get(k)!;
    },
    expire: async () => 1,
  };
  for (let i = 0; i < 3; i++) assert.equal(await joinRateLimited('1.2.3.4', redis, 3), false);
  assert.equal(await joinRateLimited('1.2.3.4', redis, 3), true);
  assert.equal(await joinRateLimited('5.6.7.8', redis, 3), false);
  const broken = { incr: async () => { throw new Error('down'); }, expire: async () => 1 };
  assert.equal(await joinRateLimited('1.2.3.4', broken, 3), false);
  assert.equal(joinRateLimitFromEnv({}), 120);
  assert.equal(joinRateLimitFromEnv({ JOIN_RATE_LIMIT_PER_MINUTE: '0' }), 0);
});

// ---------------------------------------------------------------- auto-check endpoint

test('auto-check: 401 without a school-app student session, nothing computed', async () => {
  let computed = 0;
  const res = await handleStudentCheck({
    getPupil: async () => null,
    signatureFor: async () => {
      computed++;
      return { sig: 'x', kind: 'none' };
    },
  });
  assert.equal(res.status, 401);
  assert.equal(computed, 0);
});

test('auto-check: returns only the signed-in student\'s own routing signature, uncached, and slides the session', async () => {
  const seen: string[] = [];
  let refreshed = '';
  const res = await handleStudentCheck({
    getPupil: async () => ({ id: 'st1' }),
    signatureFor: async (s) => {
      seen.push(s.id);
      return { sig: 'scheduled:slot:abc:2026-10-02:1', kind: 'scheduled' };
    },
    refreshSession: async (s) => {
      refreshed = s.id;
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { sig: 'scheduled:slot:abc:2026-10-02:1', kind: 'scheduled' });
  assert.deepEqual(seen, ['st1']);
  assert.equal(refreshed, 'st1');
});

test('route signature changes when the class goes live, so the page moves the student in', () => {
  const occ = { key: 'slot:s1:2026-10-02' } as Parameters<typeof routeSignature>[0] extends { occurrence: infer O } ? O : never;
  const waiting = routeSignature({ kind: 'scheduled', occurrence: occ, session: { id: 'cs', live: false, startedAt: null, endedAt: null } });
  const live = routeSignature({ kind: 'scheduled', occurrence: occ, session: { id: 'cs', live: true, startedAt: new Date(), endedAt: null } });
  assert.notEqual(waiting, live);
  assert.notEqual(routeSignature({ kind: 'none', next: null }), routeSignature({ kind: 'adhoc', session: { id: 'cs2', subject: 'X', startedAt: null } }));
  assert.equal(routeSignature({ kind: 'none', next: null }), 'none:');
});

test('poll delay is 10–15 s with jitter by default', () => {
  assert.equal(nextPollDelay(12_500, 2_500, () => 0), 10_000);
  assert.equal(nextPollDelay(12_500, 2_500, () => 1), 15_000);
  for (let i = 0; i < 50; i++) {
    const d = nextPollDelay();
    assert.ok(d >= 10_000 && d <= 15_000);
  }
});

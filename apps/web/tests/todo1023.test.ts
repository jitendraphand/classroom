import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modifyLabel, substituteProblem } from '../src/lib/overrideRules';
import { occurrenceConflicts, occurrencesOn, type OverrideLike, type SlotLike } from '../src/lib/schedule';

test('substitute must differ from the original teacher', () => {
  assert.match(substituteProblem('MODIFY', 't1', 't1', 'Asha')!, /different teacher from Asha/);
  assert.equal(substituteProblem('MODIFY', 't2', 't1'), null);
  assert.equal(substituteProblem('MODIFY', null, 't1'), null, 'time-only change keeps the teacher');
  assert.equal(substituteProblem('EXTRA', 't1', 't1'), null);
});

test('MODIFY label: substitute vs time change', () => {
  assert.equal(modifyLabel({ teacherId: 't2', originalTeacherId: 't1' }), 'Substitute');
  assert.equal(modifyLabel({ teacherId: null, originalTeacherId: 't1', startMinute: 600 }), 'Time change');
  assert.equal(modifyLabel({ teacherId: 't1', originalTeacherId: 't1', start: '10:00' }), 'Time change');
  assert.equal(modifyLabel({ teacherId: null, originalTeacherId: 't1' }), 'Changed');
});

const slot = (id: string, teacherId: string, start: number, end: number): SlotLike => ({
  id, teacherId, campus: 'MAIN', grade: '5', divisions: [id], allDivisions: false, subject: id,
  weekday: 1, startMinute: start, endMinute: end, effectiveFrom: null, effectiveTo: null, academicYear: '2026-27',
} as SlotLike);
const D = '2026-10-26'; // Monday

test('substitute clash: weekly class, extra class, cancellation honoured', () => {
  const slots = [slot('a', 'T1', 540, 585), slot('b', 'T2', 560, 600)];
  const sub: OverrideLike = { id: 'c', kind: 'MODIFY', date: D, slotId: 'a', teacherId: 'T2', divisions: [], allDivisions: false } as unknown as OverrideLike;
  let occs = occurrencesOn(D, slots, [sub], 'Asia/Kolkata');
  assert.equal(occurrenceConflicts(occs).teacher.length, 1, 'T2 busy with own weekly class');
  const cancelB: OverrideLike = { id: 'x', kind: 'CANCEL', date: D, slotId: 'b', divisions: [], allDivisions: false } as unknown as OverrideLike;
  occs = occurrencesOn(D, slots, [sub, cancelB], 'Asia/Kolkata');
  assert.equal(occurrenceConflicts(occs).teacher.length, 0, 'cancelled class frees the substitute');
  const extra: OverrideLike = { id: 'e', kind: 'EXTRA', date: D, slotId: null, teacherId: 'T2', campus: 'MAIN', grade: '6', divisions: ['A'], allDivisions: false, startMinute: 570, endMinute: 600, subject: 'X' } as unknown as OverrideLike;
  occs = occurrencesOn(D, slots, [sub, cancelB, extra], 'Asia/Kolkata');
  assert.equal(occurrenceConflicts(occs).teacher.length, 1, 'extra class clashes');
});

import { academicYearChoices, academicYearForDate } from '../src/lib/academicYear';
test('academic year: default June start, configurable start month, dropdown choices', () => {
  assert.equal(academicYearForDate('2026-06-01'), '2026-27');
  assert.equal(academicYearForDate('2026-05-31'), '2025-26');
  assert.equal(academicYearForDate('2026-04-01', 4), '2026-27');
  assert.equal(academicYearForDate('2026-03-31', 4), '2025-26');
  assert.equal(academicYearForDate('2026-01-05', 1), '2026-27');
  assert.deepEqual(academicYearChoices(['2024-25', 'bad'], '2026-27'), ['2027-28', '2026-27', '2025-26', '2024-25']);
});

import { generateKeyPairSync } from 'node:crypto';
import { verifySchoolJoinToken, type SchoolJwtConfig } from '../src/lib/schoolJwt';
import { resolveSchoolJoin, signedModeProblem } from '../src/lib/schoolJoin';
import { manualStudentJoinAllowed } from '../src/lib/schoolConfig';
import { signJoinToken } from '../../../docs/examples/school-website-signer.mjs';

test('website sample signer produces tokens the classroom accepts (EdDSA, once)', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const cfg: SchoolJwtConfig = {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    issuer: 'https://school.example', audience: 'classroom', maxLifetimeSeconds: 120, clockSkewSeconds: 30,
  };
  const used = new Set<string>();
  const claim = async (k: string) => (used.has(k) ? false : (used.add(k), true));
  const t = signJoinToken({ id: 'S1', name: 'Asha P', grade: '7', division: 'a' },
    { issuer: cfg.issuer, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
  const c = await verifySchoolJoinToken(t, cfg, claim);
  assert.equal(c.studentId, 'S1'); assert.equal(c.division, 'A');
  await assert.rejects(verifySchoolJoinToken(t, cfg, claim), /replayed/);
  // a token from another key is refused
  const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  await assert.rejects(verifySchoolJoinToken(signJoinToken({ id: 'S1', name: 'A', grade: '7', division: 'A' }, { issuer: cfg.issuer, privateKeyPem: other }), cfg, claim), /bad_signature/);
  // signed mode refuses plain links
  await assert.rejects(resolveSchoolJoin(new URLSearchParams('SID=S1&FirstName=A&Grade=7&Division=A'), { mode: 'signed', jwt: cfg, claimJti: claim }), /unsigned_disabled/);
});

test('signed mode: manual join off, startup check names missing config', () => {
  assert.equal(manualStudentJoinAllowed({ SCHOOL_JOIN_MODE: 'signed', ALLOW_MANUAL_STUDENT_JOIN: 'true' }), false);
  assert.equal(manualStudentJoinAllowed({ ALLOW_MANUAL_STUDENT_JOIN: 'true' }), true);
  const base = { audience: 'classroom', maxLifetimeSeconds: 120, clockSkewSeconds: 30 };
  assert.match(signedModeProblem('signed', { ...base, issuer: null })!, /ISSUER/);
  assert.match(signedModeProblem('signed', { ...base, issuer: 'x' })!, /PUBLIC_KEY/);
  assert.equal(signedModeProblem('signed', { ...base, issuer: 'x', secret: 'y'.repeat(40) }), null);
  assert.equal(signedModeProblem('unsigned', { ...base, issuer: null }), null);
});

import { linkedTeacherOk } from '../src/lib/sessionTokens';

test('linked sub-admin view dies with the teacher session generation', () => {
  const t = { sessionVersion: 3, disabled: false, deletedAt: null };
  assert.equal(linkedTeacherOk({ tv: 3 }, t), true);
  assert.equal(linkedTeacherOk({ tv: 2 }, t), false, 'teacher password changed/reset');
  assert.equal(linkedTeacherOk({}, t), false, 'token without teacher version');
  assert.equal(linkedTeacherOk({ tv: 3 }, { ...t, disabled: true }), false);
  assert.equal(linkedTeacherOk({ tv: 3 }, { ...t, deletedAt: new Date() }), false);
  assert.equal(linkedTeacherOk({ tv: 3 }, null), false);
});

import { presentAtEnd } from '../src/lib/feedbackText';

test('feedback only for students in class when it ended', () => {
  const end = new Date('2026-10-23T10:00:00Z');
  const at = (m: number) => new Date(end.getTime() + m * 60_000);
  assert.equal(presentAtEnd({ openSids: [], connectedSince: null, leftAt: end }, end), true);
  assert.equal(presentAtEnd({ openSids: [], connectedSince: null, leftAt: at(-20) }, end), false, 'left mid-class');
  assert.equal(presentAtEnd({ openSids: ['s'], connectedSince: at(-5), leftAt: at(-20) }, end), true, 'rejoined, end not processed yet');
  assert.equal(presentAtEnd({ openSids: [], connectedSince: null, leftAt: at(-1) }, end), true, 'dropped in the last minute');
  assert.equal(presentAtEnd({ openSids: [], connectedSince: null, leftAt: null }, null), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { studentAudienceStatus } from '../src/lib/gradeMasterLogic';
import { shortName } from '../src/lib/displayNames';

const master = [
  { name: '9', divisions: [{ name: 'ALPHA' }, { name: 'BETA' }] },
  { name: '10', divisions: [{ name: 'ALPHA' }] },
] as unknown as Parameters<typeof studentAudienceStatus>[0];

test('studentAudienceStatus: known grade + division is ok', () => {
  assert.equal(studentAudienceStatus(master, '9', 'ALPHA'), 'ok');
  assert.equal(studentAudienceStatus(master, '9', 'alpha'), 'ok');
});

test('studentAudienceStatus: flags unknown division and unknown grade', () => {
  assert.equal(studentAudienceStatus(master, '9', 'ZETA'), 'unknown_division');
  assert.equal(studentAudienceStatus(master, '11', 'ALPHA'), 'unknown_grade');
});

test('studentAudienceStatus: no master configured never flags', () => {
  assert.equal(studentAudienceStatus([], '9', 'ZETA'), 'ok');
});

test('shortName: first name plus last initial', () => {
  assert.equal(shortName('Test Student One'), 'Test O.');
  assert.equal(shortName('  asha   patil '), 'asha P.');
  assert.equal(shortName('Ravi'), 'Ravi');
  assert.equal(shortName(''), '');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactPersonLabel } from '../src/lib/displayNames';

test('colliding short names expand to full name and division, never SID', () => {
  const peers = [
    { id: 'GROK-TEST-1', displayName: 'Asha Patil', gradeDivision: '7-A' },
    { id: 'GROK-TEST-2', displayName: 'Asha Pawar', gradeDivision: '7-B' },
  ];
  assert.equal(compactPersonLabel(peers[0], peers), 'Asha Patil · 7-A');
  assert.equal(compactPersonLabel(peers[1], peers), 'Asha Pawar · 7-B');
  assert.equal(compactPersonLabel(peers[0], [peers[0]]), 'Asha P. · 7-A');
});
test('equal full names use division and roll where available', () => {
  const peers = [
    { id: 'GROK-TEST-1', displayName: 'Asha Patil', gradeDivision: '7-A', rollNumber: '3' },
    { id: 'GROK-TEST-2', displayName: 'Asha Patil', gradeDivision: '7-A', rollNumber: '8' },
  ];
  assert.equal(compactPersonLabel(peers[0], peers), 'Asha Patil · 7-A · Roll 3');
  assert.notEqual(compactPersonLabel(peers[0], peers), compactPersonLabel(peers[1], peers));
});

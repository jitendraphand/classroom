import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIpFrom, ipMatches } from '../src/lib/clientIp';

const h = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });

test('bare-IP deploy: the TCP peer is the client and a forged X-Forwarded-For is ignored', () => {
  assert.equal(clientIpFrom(h({ 'x-classroom-peer': '203.0.113.9', 'x-forwarded-for': '1.2.3.4' }), {}), '203.0.113.9');
  assert.equal(clientIpFrom(h({ 'x-classroom-peer': '::ffff:203.0.113.9' }), {}), '203.0.113.9');
});

test('behind Caddy on loopback: the right-most untrusted X-Forwarded-For hop is the client', () => {
  assert.equal(clientIpFrom(h({ 'x-classroom-peer': '127.0.0.1', 'x-forwarded-for': '198.51.100.7' }), {}), '198.51.100.7');
  // A client-supplied XFF in front of Caddy's appended value cannot win.
  assert.equal(clientIpFrom(h({ 'x-classroom-peer': '::1', 'x-forwarded-for': '6.6.6.6, 198.51.100.7' }), {}), '198.51.100.7');
  assert.equal(clientIpFrom(h({ 'x-classroom-peer': '127.0.0.1' }), {}), '127.0.0.1');
});

test('extra trusted proxies (load balancer subnet)', () => {
  const env = { TRUSTED_PROXIES: '10.0.0.0/8' };
  assert.equal(clientIpFrom(h({ 'x-classroom-peer': '10.1.2.3', 'x-forwarded-for': '198.51.100.7, 10.9.9.9' }), env), '198.51.100.7');
  assert.equal(clientIpFrom(h({ 'x-classroom-peer': '10.1.2.3', 'x-forwarded-for': '198.51.100.7' }), {}), '10.1.2.3');
  assert.equal(ipMatches('192.168.1.40', '192.168.1.0/24'), true);
  assert.equal(ipMatches('192.168.2.40', '192.168.1.0/24'), false);
  assert.equal(ipMatches('::1', '::1'), true);
  assert.equal(ipMatches('bad', '10.0.0.0/8'), false);
});

test('staff session lifetimes and retention knobs', async () => {
  const { sessionTtlHours } = await import('../src/lib/sessionTokens');
  const { participantRetentionDays } = await import('../src/lib/retention');
  assert.equal(sessionTtlHours('teacher', {}), 24);
  assert.equal(sessionTtlHours('teacher', { TEACHER_SESSION_HOURS: '168' }), 168);
  assert.equal(sessionTtlHours('teacher', { TEACHER_SESSION_HOURS: 'x' }), 24);
  assert.equal(sessionTtlHours('admin', {}), 12);
  assert.equal(participantRetentionDays({}), 30);
  assert.equal(participantRetentionDays({ PARTICIPANT_RETENTION_DAYS: '0' }), 0);
});

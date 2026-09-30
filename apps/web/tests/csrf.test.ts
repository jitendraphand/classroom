import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCsrf } from '../src/lib/csrf';

function h(entries: Record<string, string>) {
  const lower = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

const APP = 'https://1-2-3-4.sslip.io';

test('GET is never blocked', () => {
  const r = checkCsrf({ method: 'GET', headers: h({ origin: 'https://evil.example', host: '1-2-3-4.sslip.io' }) });
  assert.equal(r.ok, true);
});

test('same-origin JSON POST is allowed', () => {
  const r = checkCsrf({
    method: 'POST',
    headers: h({
      origin: APP,
      host: '1-2-3-4.sslip.io',
      'content-type': 'application/json',
      'content-length': '12',
    }),
    configuredOrigins: [APP],
  });
  assert.equal(r.ok, true);
});

test('sibling sslip.io origin is blocked (same-site is not same-origin)', () => {
  const r = checkCsrf({
    method: 'POST',
    headers: h({
      origin: 'https://9-9-9-9.sslip.io',
      host: '1-2-3-4.sslip.io',
      'content-type': 'application/json',
      'content-length': '12',
    }),
    configuredOrigins: [APP],
  });
  assert.deepEqual(r, { ok: false, status: 403, reason: 'Cross-site request blocked' });
});

test('opaque "null" origin is blocked', () => {
  const r = checkCsrf({ method: 'POST', headers: h({ origin: 'null', host: '1-2-3-4.sslip.io' }) });
  assert.equal(r.ok, false);
});

test('no Origin but Sec-Fetch-Site same-site is blocked', () => {
  const r = checkCsrf({ method: 'POST', headers: h({ host: 'a', 'sec-fetch-site': 'same-site' }) });
  assert.equal(r.ok, false);
});

test('non-browser client without Origin (Android app, curl) is allowed', () => {
  const r = checkCsrf({
    method: 'POST',
    headers: h({ host: '1-2-3-4.sslip.io', 'content-type': 'application/json; charset=utf-8', 'content-length': '2' }),
  });
  assert.equal(r.ok, true);
});

test('text/plain body is rejected with 415 even from the same origin', () => {
  const r = checkCsrf({
    method: 'POST',
    headers: h({ origin: APP, host: '1-2-3-4.sslip.io', 'content-type': 'text/plain', 'content-length': '20' }),
  });
  assert.deepEqual(r, { ok: false, status: 415, reason: 'Content-Type must be application/json' });
});

test('bodyless POST (logout, end) needs no content type', () => {
  const r = checkCsrf({ method: 'POST', headers: h({ origin: APP, host: '1-2-3-4.sslip.io', 'content-length': '0' }) });
  assert.equal(r.ok, true);
});

test('Origin matching X-Forwarded-Host (behind Caddy) is allowed', () => {
  const r = checkCsrf({
    method: 'PATCH',
    headers: h({ origin: APP, host: '127.0.0.1:3000', 'x-forwarded-host': '1-2-3-4.sslip.io' }),
  });
  assert.equal(r.ok, true);
});

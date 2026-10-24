import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AUTO_RECOVER_MAX,
  buildClientErrorReport,
  sanitizeClientErrorBody,
  scrub,
  shouldAutoRecover,
} from '../src/lib/clientError';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('error boundary logs and reports the real error', () => {
  const g = read('../src/components/classroom/ClassroomGuard.tsx');
  assert.match(g, /componentDidCatch\(error: unknown, info/);
  assert.match(g, /console\.error\('\[classroom\] crash'/);
  assert.match(g, /'\/api\/client-error'/);
  assert.match(g, /shouldAutoRecover/);
  assert.match(g, /Try again/);
  const r = read('../src/app/api/client-error/route.ts');
  assert.match(r, /console\.error\('\[client-error\]'/);
});

test('report captures message, stack and component stack, scrubbed', () => {
  const err = new TypeError("Cannot read properties of undefined (reading 'track')");
  const rep = buildClientErrorReport('ABC', err, '\n at VideoTrack\n at Stage', { url: '/class/ABC?t=secret', attempt: 1 });
  assert.equal(rep.name, 'TypeError');
  assert.match(rep.message, /reading 'track'/);
  assert.match(rep.stack, /TypeError/);
  assert.match(rep.componentStack, /VideoTrack/);
  assert.ok(!rep.url.includes('secret'));
  assert.equal(rep.attempt, 1);
  assert.equal(buildClientErrorReport('X', 'boom', null).message, 'boom');
  assert.equal(buildClientErrorReport('X', null, undefined).message, '');
  assert.ok(!scrub('x eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abcdef y').includes('eyJ'));
});

test('server sanitizer caps and rejects junk', () => {
  assert.equal(sanitizeClientErrorBody(null), null);
  assert.equal(sanitizeClientErrorBody({ foo: 1 }), null);
  const r = sanitizeClientErrorBody({ code: 'A', message: 'm'.repeat(5000), stack: 's', evil: 'x' })!;
  assert.equal(r.message.length, 500);
  assert.ok(!('evil' in r));
});

test('auto recovery is bounded', () => {
  const now = 100_000;
  assert.ok(shouldAutoRecover([], now));
  assert.equal(shouldAutoRecover(Array(AUTO_RECOVER_MAX).fill(now - 1000), now), false);
  assert.ok(shouldAutoRecover(Array(AUTO_RECOVER_MAX).fill(now - 120_000), now));
});

test('render-time stroke updaters cannot throw into the boundary', () => {
  assert.match(read('../src/components/classroom/ShareDrawing.tsx'), /try \{\s*return applyPacket\(s, p\);\s*\} catch \{\s*return s;/);
  assert.match(read('../src/components/classroom/TeacherInk.tsx'), /try \{\s*return applyInk\(s, msg\);\s*\} catch \{\s*return s;/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('teacher admission reports failures, capacity conflicts and partial admits', () => {
  const src = readFileSync('src/components/classroom/ClassroomRoom.tsx', 'utf8');
  const admit = src.slice(src.indexOf('async function admitStudents'), src.indexOf('// Separate chat / roster'));
  assert.match(admit, /if \(!res.ok\)/);
  assert.match(admit, /data.error/);
  assert.match(admit, /res.status === 409/);
  assert.match(admit, /remaining students are still waiting/);
  assert.match(admit, /catch \{/);
  assert.match(src, /notice=\{hudNotice \|\| undefined\}/, 'inline and floating share controls both show admission feedback');
});
test('waiting students get capacity guidance and inline fetch errors', () => {
  const src = readFileSync('src/app/join/[code]/page.tsx', 'utf8');
  assert.match(src, /when a seat becomes available/);
  assert.match(src, /role="alert">\{error\}/);
});

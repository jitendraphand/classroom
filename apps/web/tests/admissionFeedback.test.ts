import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('teacher admission reports failures and partial admits (no class-size limit)', () => {
  const src = readFileSync('src/components/classroom/ClassroomRoom.tsx', 'utf8');
  const admit = src.slice(src.indexOf('async function admitStudents'), src.indexOf('// Separate chat / roster'));
  assert.match(admit, /if \(!res.ok\)/);
  assert.match(admit, /data.error/);
  assert.doesNotMatch(admit, /class is full/i);
  assert.match(admit, /remaining students are still waiting/);
  assert.match(admit, /catch \{/);
  assert.match(src, /notice=\{hudNotice \|\| undefined\}/, 'inline and floating share controls both show admission feedback');
});
test('waiting students see inline fetch errors and never a "class full" notice', () => {
  const src = readFileSync('src/app/join/[code]/page.tsx', 'utf8');
  assert.doesNotMatch(src, /classFull|class is full|seat becomes available/i);
  assert.match(src, /role="alert">\{error\}/);
});

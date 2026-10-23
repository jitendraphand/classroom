import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertKnownStudent, studentRegistryModeFromEnv } from '../src/lib/studentService';

const db = (known: string[], imported: boolean) => ({
  student: {
    findUnique: async ({ where }: { where: { externalId: string } }) => (known.includes(where.externalId) ? { id: 'x' } : null),
    findFirst: async () => (imported ? { id: 'i' } : null),
  },
});

test('student registry: unknown SID is rejected with a clear code', async () => {
  await assert.rejects(assertKnownStudent('S9', 'strict', db(['S1'], false)), /unknown_student/);
  await assert.rejects(assertKnownStudent('S9', 'auto', db(['S1'], true)), /unknown_student/);
  await assertKnownStudent('S9', 'auto', db([], false));
  await assertKnownStudent('S9', 'open', db([], true));
  await assertKnownStudent('S1', 'strict', db(['S1'], false));
  assert.equal(studentRegistryModeFromEnv({}), 'auto');
  assert.equal(studentRegistryModeFromEnv({ STUDENT_REGISTRY: 'Strict' }), 'strict');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { studentHomePath } from '../src/lib/classroomClient';
import { roomEntryUrl } from '../src/lib/studentService';

test('school-app students go home to /student, guests to /', () => {
  assert.equal(studentHomePath(true), '/student');
  assert.equal(studentHomePath(false), '/');
});

test('admitted students skip the lobby; waiting ones see it', () => {
  assert.equal(roomEntryUrl('ABC123', 'ADMITTED'), '/classroom/ABC123');
  assert.equal(roomEntryUrl('ABC123', 'WAITING'), '/join/ABC123?waiting=1&as=student');
  assert.equal(roomEntryUrl('ABC123', undefined), '/join/ABC123?waiting=1&as=student');
});

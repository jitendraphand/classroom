import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate, formatDateTime, formatMonth, formatTime, formatTimeRange } from '../src/lib/timeFormat';

test('times are 24-hour, in the school zone when given; HH:MM strings pass through', () => {
  const at = '2026-10-28T03:56:00Z';
  assert.equal(formatTime(at, 'Asia/Kolkata'), '09:26');
  assert.equal(formatTime(at, 'UTC'), '03:56');
  assert.equal(formatTime('9:05'), '09:05');
  assert.equal(formatTime('14:30', 'Asia/Kolkata'), '14:30');
  assert.equal(formatTime(null), '');
  assert.equal(formatTime('not a date'), '');
  assert.equal(formatTimeRange('09:26', '10:11'), '09:26–10:11');
});

test('calendar dates never shift with the time zone; one shape everywhere', () => {
  assert.equal(formatDate('2026-10-28'), 'Wed 28 Oct');
  assert.equal(formatDate('2026-10-28', { timeZone: 'America/Los_Angeles' }), 'Wed 28 Oct');
  assert.equal(formatDate('2026-10-28', { year: true }), 'Wed 28 Oct 2026');
  assert.equal(formatDate('2026-10-28', { long: true }), 'Wednesday 28 October');
  assert.equal(formatDate('2026-10-28', { weekday: false }), '28 Oct');
  // An instant late on the 27th UTC is already the 28th in India.
  assert.equal(formatDate('2026-10-27T20:00:00Z', { timeZone: 'Asia/Kolkata' }), 'Wed 28 Oct');
});

test('date-times add the year only when it is not this year; months read as words', () => {
  const now = new Date('2026-10-28T06:00:00Z');
  assert.equal(formatDateTime('2026-10-28T04:10:00Z', 'Asia/Kolkata', now), 'Wed 28 Oct, 09:40');
  assert.equal(formatDateTime('2025-03-03T04:10:00Z', 'Asia/Kolkata', now), 'Mon 3 Mar 2025, 09:40');
  assert.equal(formatMonth('2026-10'), 'October 2026');
  assert.equal(formatMonth('bad'), 'bad');
});

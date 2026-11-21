import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageAccess, TEACHER_LIST_VIEW, TEACHER_NAMES_VIEW, visibleAdminSections } from '../src/lib/adminSections';
import { hasAnyPrivilege, privilegeSetFrom } from '../src/lib/privileges';
import { teacherNamesOnly } from '../src/lib/teachers';

// The Nov 7 trial sub-admin: "Monitor live + Reports only".
const monitorReports = privilegeSetFrom({ kind: 'SUB', privMonitorLive: true, privViewReports: true });

test('sub-admin with monitor + reports does not get the Teachers tab or page (Nov 7 trial)', () => {
  const tabs = visibleAdminSections(monitorReports, 'SUB');
  assert.ok(!tabs.includes('teachers'), tabs.join());
  assert.deepEqual(tabs, ['today', 'live', 'attendance', 'performance']);
  const access = pageAccess('/admin/teachers', monitorReports, 'SUB');
  assert.equal(access.ok, false);
  assert.equal(pageAccess('/admin/reports', monitorReports, 'SUB').ok, true);
  assert.equal(pageAccess('/admin/live', monitorReports, 'SUB').ok, true);
});

test('teachers tab still shows for teacher managers, schedulers and the system admin', () => {
  for (const p of [{ privManageTeachers: true }, { privSchedule: true }]) {
    assert.ok(visibleAdminSections(privilegeSetFrom({ kind: 'SUB', ...p }), 'SUB').includes('teachers'));
  }
  assert.ok(visibleAdminSections(privilegeSetFrom({ kind: 'SYSTEM' }), 'SYSTEM').includes('teachers'));
});

test('teacher list API: full rows only for manageTeachers/schedule; report-only gets names', () => {
  assert.equal(hasAnyPrivilege(monitorReports, 'SUB', TEACHER_LIST_VIEW), false);
  assert.equal(hasAnyPrivilege(monitorReports, 'SUB', TEACHER_NAMES_VIEW), true);
  const liveOnly = privilegeSetFrom({ kind: 'SUB', privMonitorLive: true });
  assert.equal(hasAnyPrivilege(liveOnly, 'SUB', TEACHER_NAMES_VIEW), false, 'monitor-only gets 403');
  const full = [{ id: 't1', name: 'GROK-TEST Teacher One', disabled: false, email: 'x@y.z', permanentCode: 'TA9NTA', assignments: [] }];
  assert.deepEqual(teacherNamesOnly(full), [{ id: 't1', name: 'GROK-TEST Teacher One', disabled: false }]);
  const route = readFileSync('src/app/api/admin/teachers/route.ts', 'utf8');
  assert.match(route, /requireAdminApi\(TEACHER_NAMES_VIEW\)/);
  assert.match(route, /hasAnyPrivilege\(admin\.privileges, admin\.kind, TEACHER_LIST_VIEW\)/);
  assert.match(route, /teacherNamesOnly\(teachers\)/);
});

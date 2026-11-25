import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adminApiDenied } from '../src/lib/adminGuard';
import { pageAccess, visibleAdminSections, visibleSettingsItems } from '../src/lib/adminSections';
import { allPrivileges, hasPrivilege } from '../src/lib/privileges';
import { passwordProblem } from '../src/lib/passwords';
import {
  mutateSubAdminDenied,
  NEW_SUB_ADMIN_KIND,
  rejectedKindChange,
  resolveNewSubAdminPassword,
} from '../src/lib/subAdminAccounts';

const src = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8');

const fullSub = { kind: 'SUB', privileges: allPrivileges(true) };
const system = { kind: 'SYSTEM', privileges: allPrivileges(true) };

test('a chosen password is kept; a missing one is generated and must be changed', () => {
  const chosen = resolveNewSubAdminPassword('correct horse battery', { email: 'deputy@school.test' });
  assert.equal(chosen.ok, true);
  if (!chosen.ok) return;
  assert.equal(chosen.generated, false);
  assert.equal(chosen.mustChangePassword, false);
  assert.equal(chosen.password, 'correct horse battery');

  const generated = resolveNewSubAdminPassword('', { email: 'deputy@school.test' });
  assert.equal(generated.ok, true);
  if (!generated.ok) return;
  assert.equal(generated.generated, true);
  assert.equal(generated.mustChangePassword, true);
  assert.equal(passwordProblem(generated.password), null);
  const again = resolveNewSubAdminPassword(undefined);
  assert.equal(again.ok, true);
  if (again.ok && generated.ok) assert.notEqual(again.password, generated.password);
});

test('weak or email-based passwords are refused', () => {
  assert.equal(resolveNewSubAdminPassword('short').ok, false);
  assert.equal(resolveNewSubAdminPassword('aaaaaaaaaaaa').ok, false);
  const emailName = resolveNewSubAdminPassword('deputy-secret-1', { email: 'deputy@school.test' });
  assert.equal(emailName.ok, false);
  assert.equal(resolveNewSubAdminPassword(12).ok, false);
});

test('create/edit cannot elevate a sub-admin to system administrator', () => {
  assert.equal(NEW_SUB_ADMIN_KIND, 'SUB');
  assert.equal(rejectedKindChange({ kind: 'SYSTEM' }), 'A sub-administrator cannot be made the system administrator');
  assert.equal(rejectedKindChange({ kind: 'admin' }), 'A sub-administrator cannot be made the system administrator');
  assert.equal(rejectedKindChange({ kind: 'SUB' }), null);
  assert.equal(rejectedKindChange({ name: 'x' }), null);
  assert.equal(rejectedKindChange(null), null);
});

test('the system administrator row cannot be edited or deleted, including by itself', () => {
  const sys = { id: 'sys1', kind: 'SYSTEM' };
  const sub = { id: 'sub1', kind: 'SUB' };
  assert.equal(mutateSubAdminDenied(null, { action: 'edit' }).ok, false);
  assert.equal(mutateSubAdminDenied(sys, { action: 'edit' }).ok, false);
  assert.equal(mutateSubAdminDenied(sys, { action: 'delete', actorId: 'sys1' }).ok, false);
  const self = mutateSubAdminDenied(sub, { action: 'delete', actorId: 'sub1' });
  assert.equal(self.ok, false);
  if (!self.ok) assert.equal(self.error, 'You cannot delete your own account');
  const okEdit = mutateSubAdminDenied(sub, { action: 'edit', actorId: 'sys1' });
  assert.equal(okEdit.ok, true);
  const okDel = mutateSubAdminDenied(sub, { action: 'delete', actorId: 'sys1' });
  assert.equal(okDel.ok, true);
});

test('a full-privilege sub-admin has every school privilege but is blocked from admin-management APIs', () => {
  for (const p of ['manageTeachers', 'schedule', 'monitorLive', 'viewReports', 'manageSchool'] as const) {
    assert.equal(hasPrivilege(fullSub.privileges, 'SUB', p), true);
  }
  assert.equal(adminApiDenied(fullSub, 'manageTeachers'), null);
  assert.equal(adminApiDenied(fullSub, 'schedule'), null);
  assert.equal(adminApiDenied(fullSub, 'monitorLive'), null);
  assert.equal(adminApiDenied(fullSub, 'viewReports'), null);
  assert.equal(adminApiDenied(fullSub, 'manageSchool'), null);
  const blocked = adminApiDenied(fullSub, 'SYSTEM');
  assert.equal(blocked?.status, 403);
  assert.match(blocked?.error ?? '', /system administrator/i);
  assert.equal(adminApiDenied(system, 'SYSTEM'), null);
  assert.equal(adminApiDenied(null, 'SYSTEM')?.status, 401);
});

test('the Sub-administrators page and Settings card are hidden from a full-privilege sub-admin', () => {
  const sections = visibleAdminSections(fullSub.privileges, 'SUB');
  assert.deepEqual(sections, ['today', 'live', 'timetable', 'teachers', 'students', 'attendance', 'performance', 'settings']);
  assert.equal(pageAccess('/admin/system/admins', fullSub.privileges, 'SUB').ok, false);
  assert.equal(pageAccess('/admin/teachers', fullSub.privileges, 'SUB').ok, true);
  assert.equal(pageAccess('/admin/system/admins', system.privileges, 'SYSTEM').ok, true);
  const cards = visibleSettingsItems(fullSub.privileges, 'SUB').map((c) => c.href);
  assert.equal(cards.includes('/admin/system/admins'), false);
  assert.ok(visibleSettingsItems(system.privileges, 'SYSTEM').some((c) => c.href === '/admin/system/admins'));
});

test('admin-management routes enforce SYSTEM on the server and never write kind SYSTEM', () => {
  const list = src('app/api/admin/sub-admins/route.ts');
  const one = src('app/api/admin/sub-admins/[id]/route.ts');
  const page = src('app/admin/system/admins/page.tsx');
  assert.match(list, /requireAdminApi\('SYSTEM'\)/);
  assert.match(one, /requireAdminApi\('SYSTEM'\)/);
  assert.match(list, /NEW_SUB_ADMIN_KIND/);
  assert.match(list, /resolveNewSubAdminPassword/);
  assert.match(list, /rejectedKindChange/);
  assert.match(one, /mutateSubAdminDenied/);
  assert.match(one, /rejectedKindChange/);
  assert.doesNotMatch(list, /kind:\s*'SYSTEM'(?!\s*\|)/);
  assert.doesNotMatch(one, /kind:\s*'SYSTEM'(?!\s*\|)/);
  assert.match(page, /password: form.password/);
  assert.match(page, /Grant every privilege except managing administrators/);
});

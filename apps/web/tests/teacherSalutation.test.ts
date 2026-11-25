import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatTeacherName, genderLabel, parseTeacherGender } from '../src/lib/teacherSalutation';

test('parseTeacherGender accepts male/female only', () => {
  assert.equal(parseTeacherGender('Male'), 'male');
  assert.equal(parseTeacherGender('FEMALE'), 'female');
  assert.equal(parseTeacherGender('m'), 'male');
  assert.equal(parseTeacherGender(''), null);
  assert.equal(parseTeacherGender('other'), null);
  assert.equal(parseTeacherGender(undefined), null);
  assert.equal(genderLabel('male'), 'Male');
  assert.equal(genderLabel(null), null);
});

test("formatTeacherName appends Sir/Ma'am only when gender is set", () => {
  assert.equal(formatTeacherName('Jitendra Phand', 'male', 'plain'), 'Jitendra Phand Sir');
  assert.equal(formatTeacherName('Jitendra Phand', 'male', 'possessive'), "Jitendra Phand Sir's");
  assert.equal(formatTeacherName('Priya Sharma', 'female', 'plain'), "Priya Sharma Ma'am");
  assert.equal(formatTeacherName('Priya Sharma', 'female', 'possessive'), "Priya Sharma Ma'am's");
  assert.equal(formatTeacherName('Ajay Sharma', null, 'possessive'), 'Ajay Sharma');
  assert.equal(formatTeacherName('  Asha   Patil  ', undefined, 'plain'), 'Asha Patil');
  assert.equal(formatTeacherName('', 'male'), '');
});

test('admin teacher form asks for gender; reports use two filter rows; student page uses salutations', () => {
  const root = new URL('../src/', import.meta.url);
  const teachers = readFileSync(new URL('app/admin/teachers/page.tsx', root), 'utf8');
  assert.match(teachers, /GenderSelect/);
  assert.match(teachers, /Male \(Sir\)/);
  assert.match(teachers, /required/);
  const create = readFileSync(new URL('app/api/admin/teachers/route.ts', root), 'utf8');
  assert.match(create, /z\.enum\(\['male', 'female'\]/);
  const reports = readFileSync(new URL('components/reports/ReportView.tsx', root), 'utf8');
  assert.match(reports, /grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4/);
  assert.equal((reports.match(/lg:grid-cols-4/g) || []).length, 2);
  assert.doesNotMatch(reports, /lg:grid-cols-7/);
  const student = readFileSync(new URL('app/student/page.tsx', root), 'utf8');
  assert.match(student, /formatTeacherName/);
  assert.match(student, /teacherLine\(next\)/);
  const migration = readFileSync(new URL('../prisma/migrations/20261125120000_teacher_gender/migration.sql', root), 'utf8');
  assert.match(migration, /ADD COLUMN "gender"/);
  assert.match(migration, /Jitendra Phand/);
  assert.match(migration, /'male'/);
});

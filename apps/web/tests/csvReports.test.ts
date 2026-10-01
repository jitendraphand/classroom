import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toCsv } from '../src/lib/csv';
import { summariseByStudent, type DetailRow } from '../src/lib/reports';
import { parseRoster } from '../src/lib/roster';

test('csv: escaping, BOM, CRLF and formula injection', () => {
  const out = toCsv(['Name', 'Note'], [
    ['Asha, "A"', 'line1\nline2'],
    ['=HYPERLINK("x")', -3],
    [null, '@cmd'],
  ]);
  assert.ok(out.startsWith('\uFEFFName,Note\r\n'));
  assert.ok(out.includes('"Asha, ""A""","line1\nline2"'));
  assert.ok(out.includes(`"'=HYPERLINK(""x"")",-3`), 'numbers are not prefixed, formulas are');
  assert.ok(out.includes(",'@cmd"));
  const back = parseCsv(out);
  assert.deepEqual(back[1], ['Asha, "A"', 'line1\nline2']);
  assert.equal(back.length, 4);
});

test('roster: header aliases, normalisation, per-line errors', () => {
  const { rows, errors } = parseRoster('Student ID,Name,Class,Div,Roll No\nS1,Asha Patil, 7 ,b,1\n,No Id,7,A,2\nS1,Dup,7,A,3\nS2,Ravi,7,*,4\nS3,Meera,8,A,\n');
  assert.deepEqual(
    rows.map((r) => [r.externalId, r.grade, r.division, r.rollNumber]),
    [
      ['S1', '7', 'B', '1'],
      ['S3', '8', 'A', null],
    ]
  );
  assert.equal(errors.length, 3);
  const noHeader = parseRoster('S9,Kiran,6,C,7');
  assert.equal(noHeader.rows[0]?.name, 'Kiran');
  assert.match(parseRoster('id,name\nS1,X').errors[0]!, /Missing column/);
});

function row(studentId: string, status: DetailRow['status'], connectedMin = 30): DetailRow {
  return {
    sessionId: Math.random().toString(36),
    date: '2026-10-01',
    subject: 'Maths',
    teacher: 'T',
    audience: '7-A',
    studentId,
    externalId: `X${studentId}`,
    name: `N${studentId}`,
    rollNumber: studentId,
    gradeDivision: '7-A',
    status,
    statusLabel: status,
    firstJoined: '',
    admitted: '',
    left: '',
    connectedMin,
  };
}

test('reports: per-student summary and percentage', () => {
  const out = summariseByStudent([row('2', 'present'), row('2', 'late'), row('2', 'absent', 0), row('10', 'not_admitted', 0), row('2', 'present')]);
  assert.deepEqual(out.map((s) => s.studentId), ['2', '10'], 'roll numbers sort numerically');
  const s = out[0]!;
  assert.equal(s.classes, 4);
  assert.equal(s.present, 2);
  assert.equal(s.late, 1);
  assert.equal(s.absent, 1);
  assert.equal(s.attendancePct, 75);
  assert.equal(s.connectedMin, 90);
  assert.equal(out[1]!.attendancePct, 0);
});

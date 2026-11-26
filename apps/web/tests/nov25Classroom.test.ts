import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DRAW_GROUP_TOOLS, DRAW_GROUP_LABEL } from '../src/lib/whiteboard/toolGroups';
import {
  CAMERA_REQUIRED,
  muteOnCameraOff,
  rosterMicState,
  speakingFloatState,
  speakingStudents,
  studentCameraAllowed,
  teacherUnmuteBlock,
} from '../src/lib/speakingRules';
import { audienceIncludes, audiencesOverlap, canTeachAudience, formatAudienceOf, parseCampusList, type Assignment } from '../src/lib/grades';
import { adhocCampuses, adhocDivisions, adhocGrades, adhocProblem, type AdhocGradeChoice } from '../src/lib/adhocForm';
import { sortGradeOptions } from '../src/lib/gradeOrder';
import { gradeInput, newGradeSortOrder } from '../src/lib/gradeMasterLogic';
import { slotsClash, type ClashSlot } from '../src/lib/timetableClashes';
import { addAssignments } from '../src/lib/assignmentPick';
import { PEER_HEADER_MIN_W, compactWhiteboardVideo, fitPaneToTiles } from '../src/lib/floatGeometry';
import { studentPlaceLabel } from '../src/lib/audienceLabels';
import { classroomGrant } from '../src/lib/livekit';

const src = (p: string) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

// Item 2
test('laser pointer is in the pen / text writing group, not its own button', () => {
  assert.deepEqual([...DRAW_GROUP_TOOLS], ['pen', 'hl', 'text', 'laser']);
  assert.match(DRAW_GROUP_LABEL, /laser/);
  const board = src('lib/whiteboard/WhiteboardBoard.tsx');
  assert.match(board, /DRAW_GROUP_TOOLS\.map/);
});

// Item 3
test('unmute needs the camera on', () => {
  assert.equal(teacherUnmuteBlock({ camOn: false }), CAMERA_REQUIRED);
  assert.equal(teacherUnmuteBlock({ camOn: undefined }), CAMERA_REQUIRED);
  assert.equal(teacherUnmuteBlock({ camOn: true }), null);
});

test('camera off while unmuted mutes the student; never the teacher or a muted student', () => {
  assert.equal(muteOnCameraOff({ camOn: false, mutedByTeacher: false, role: 'STUDENT' }), true);
  assert.equal(muteOnCameraOff({ camOn: true, mutedByTeacher: false, role: 'STUDENT' }), false);
  assert.equal(muteOnCameraOff({ camOn: false, mutedByTeacher: true, role: 'STUDENT' }), false);
  assert.equal(muteOnCameraOff({ camOn: false, mutedByTeacher: false, role: 'TEACHER' }), false);
});

test('mute route: no unmute-all, single unmute checks the camera (409)', () => {
  const r = src('app/api/rooms/[code]/mute/route.ts');
  assert.match(r, /NO_UNMUTE_ALL/);
  assert.match(r, /409/);
  assert.match(r, /isStudentCamOn/);
  for (const f of ['components/classroom/Controls.tsx', 'components/classroom/ClassroomRoom.tsx', 'components/classroom/TeacherShareHud.tsx', 'components/classroom/MeetingBar.tsx']) {
    assert.doesNotMatch(src(f), /Allow all to unmute/, f);
  }
  assert.match(src('components/classroom/MeetingBar.tsx'), /Mute all students/);
});

test('several students can be unmuted at once (one click each)', () => {
  const admitted = [
    { role: 'STUDENT', mutedByTeacher: false, livekitIdentity: 'a', id: 'a', displayName: 'a' },
    { role: 'STUDENT', mutedByTeacher: false, livekitIdentity: 'b', id: 'b', displayName: 'b' },
    { role: 'STUDENT', mutedByTeacher: true, livekitIdentity: 'c', id: 'c', displayName: 'c' },
    { role: 'TEACHER', mutedByTeacher: false, livekitIdentity: 't', id: 't', displayName: 't' },
  ];
  assert.deepEqual(speakingStudents(admitted).map((p) => p.livekitIdentity), ['a', 'b']);
  assert.deepEqual(speakingStudents(admitted, (id) => id === 'b').map((p) => p.livekitIdentity), ['a']);
});

// Steering: three-state roster mic
test('roster mic: locked / allowed / live, and what a click does', () => {
  const locked = rosterMicState({ name: 'Asha', mutedByTeacher: true, micLive: false, camOn: true });
  assert.equal(locked.state, 'locked');
  assert.equal(locked.action, 'allow');
  assert.equal(locked.disabled, false);
  assert.match(locked.label, /not allowed to unmute/);
  const noCam = rosterMicState({ name: 'Asha', mutedByTeacher: true, micLive: false, camOn: false });
  assert.equal(noCam.disabled, true);
  assert.match(noCam.label, /Camera must be on/);
  const allowed = rosterMicState({ name: 'Asha', mutedByTeacher: false, micLive: false, camOn: true });
  assert.equal(allowed.state, 'allowed');
  assert.equal(allowed.action, 'mute');
  assert.match(allowed.label, /allowed to unmute/);
  const live = rosterMicState({ name: 'Asha', mutedByTeacher: false, micLive: true, camOn: true });
  assert.equal(live.state, 'live');
  assert.equal(live.action, 'mute');
  // No speaking slot under the mic limit counts as not allowed.
  assert.equal(rosterMicState({ name: 'A', mutedByTeacher: false, micLive: false, allowed: false, camOn: true }).state, 'locked');
});

test('roster + HUD render the three mic states with distinct icons', () => {
  for (const f of ['components/classroom/ClassroomRoom.tsx', 'components/classroom/TeacherShareHud.tsx']) {
    const s = src(f);
    assert.match(s, /rosterMicState\(/, f);
    assert.match(s, /IconMicLock/, f);
  }
  const css = src('app/globals.css');
  assert.match(css, /\.roster-icon-btn-locked/);
  assert.match(css, /\.roster-icon-btn-allowed/);
  assert.match(css, /\.roster-icon-btn-live/);
});

// Item 4
test('unmuted students may publish camera for the teacher pop-up; others need sample or spotlight', () => {
  assert.equal(studentCameraAllowed({ inSample: false, unmuted: true }), true);
  assert.equal(studentCameraAllowed({ inSample: false, spotlighted: true }), true);
  assert.equal(studentCameraAllowed({ inSample: false }), false);
  const open = classroomGrant({ roomName: 'r', role: 'STUDENT', mutedByTeacher: false, micLocked: false, allowCamera: false } as Parameters<typeof classroomGrant>[0]);
  assert.ok((open.canPublishSources ?? []).length >= 2, 'unmuted: mic + camera');
  const muted = classroomGrant({ roomName: 'r', role: 'STUDENT', mutedByTeacher: true, micLocked: false, allowCamera: false } as Parameters<typeof classroomGrant>[0]);
  assert.equal(muted.canPublish, false);
});

test('speaking pop-up opens with speakers, a close holds until someone new is unmuted', () => {
  assert.deepEqual(speakingFloatState([], null), { open: false, reopen: false });
  assert.deepEqual(speakingFloatState(['a'], null), { open: true, reopen: false });
  assert.equal(speakingFloatState(['a'], ['a']).open, false);
  assert.deepEqual(speakingFloatState(['a', 'b'], ['a']), { open: true, reopen: true });
  assert.equal(speakingFloatState([], ['a']).reopen, true);
  const room = src('components/classroom/ClassroomRoom.tsx');
  assert.match(room, /isTeacher && speakers\.length > 0 && <SpeakingStudentsFloat/);
  assert.match(room, /keepIdentities=\{speakers\.map/);
});

// Item 1
test('teacher header: no title/code block; (i) hover info with code, videos, students, live', () => {
  const room = src('components/classroom/ClassroomRoom.tsx');
  assert.match(room, /\(!isTeacher \|\| raisedHands\.length > 0\)/);
  assert.match(room, /const teacherInfoEl = /);
  for (const k of ['Class code', 'Videos shown', 'Students', 'Status']) assert.match(room, new RegExp(`k: '${k}'`));
  assert.match(room, /info=\{teacherInfoEl\('left'\)\}/);
  const info = src('components/classroom/ClassInfoButton.tsx');
  assert.match(info, /onMouseEnter=\{hover/);
  assert.match(info, /placement === 'left'/);
});

test('teacher notice is an overlay and toasts clear the meeting bar', () => {
  const css = src('app/globals.css');
  assert.match(css, /\.teacher-banner \{[^}]*position: fixed/);
  assert.match(css, /right: calc\(16px \+ var\(--wb-bar-right, 0px\)\)/);
  assert.match(src('components/classroom/ClassroomRoom.tsx'), /--wb-bar-right/);
});

// Item 5
test('roster shows the name only', () => {
  const room = src('components/classroom/ClassroomRoom.tsx');
  assert.doesNotMatch(room, /\{p\.gradeDivision && <span/);
  assert.doesNotMatch(src('components/classroom/TeacherShareHud.tsx'), /gradeDivision && <span/);
  assert.match(room, /function rosterLabel\([^)]*\): string \{\n  return p\.displayName;/);
});

// Item 6
test('multi-campus audience: includes, overlap, title, teacher must be assigned in every campus', () => {
  const a = { campus: 'AIRPORTCAMPUS', campuses: ['AIRPORTCAMPUS', 'CITYCAMPUS'], grade: '7', divisions: [], allDivisions: true };
  assert.equal(audienceIncludes(a, { campus: 'CITYCAMPUS', grade: '7', division: 'A' }), true);
  assert.equal(audienceIncludes(a, { campus: 'HILLCAMPUS', grade: '7', division: 'A' }), false);
  assert.equal(audiencesOverlap(a, { campus: 'CITYCAMPUS', grade: '7', divisions: ['B'], allDivisions: false }), true);
  assert.match(formatAudienceOf(a), /CITYCAMPUS/);
  assert.deepEqual(parseCampusList('airportcampus, CityCampus;airportcampus'), ['AIRPORTCAMPUS', 'CITYCAMPUS']);
  const mine: Assignment[] = [
    { campus: 'AIRPORTCAMPUS', grade: '7', division: '*' },
    { campus: 'CITYCAMPUS', grade: '7', division: 'A' },
  ];
  assert.equal(canTeachAudience(mine, ['AIRPORTCAMPUS', 'CITYCAMPUS'], '7', ['A'], false), true);
  assert.equal(canTeachAudience(mine, ['AIRPORTCAMPUS', 'CITYCAMPUS'], '7', [], true), false);
  assert.equal(canTeachAudience(mine, ['AIRPORTCAMPUS', 'HILLCAMPUS'], '7', ['A'], false), false);
});

test('legacy single-campus rows still work (campuses empty)', () => {
  const old = { campus: 'AIRPORTCAMPUS', campuses: [], grade: '7', divisions: [], allDivisions: true };
  assert.equal(audienceIncludes(old, { campus: 'AIRPORTCAMPUS', grade: '7', division: 'B' }), true);
  const mig = fs.readFileSync(path.join(__dirname, '..', 'prisma/migrations/20261125170000_multi_campus_audience/migration.sql'), 'utf8');
  assert.match(mig, /ARRAY\["?campus"?\]/);
});

test('ad-hoc start: grade → any campuses → divisions offered in every campus', () => {
  const choices: AdhocGradeChoice[] = [
    { campus: 'AIRPORTCAMPUS', grade: '7', label: 'Grade 7', whole: true, divisions: [{ name: 'A', label: 'A' }, { name: 'B', label: 'B' }] },
    { campus: 'CITYCAMPUS', grade: '7', label: 'Grade 7', whole: false, divisions: [{ name: 'B', label: 'B' }] },
    { campus: 'AIRPORTCAMPUS', grade: '10', label: 'Grade 10', whole: true, divisions: [] },
  ];
  assert.deepEqual(adhocGrades(choices).map((g) => g.grade), ['7', '10']);
  assert.deepEqual(adhocCampuses(choices, '7').map((c) => c.campus), ['AIRPORTCAMPUS', 'CITYCAMPUS']);
  const both = adhocDivisions(choices, '7', ['AIRPORTCAMPUS', 'CITYCAMPUS']);
  assert.deepEqual(both.divisions.map((d) => d.name), ['B']);
  assert.equal(both.whole, false);
  assert.equal(adhocDivisions(choices, '7', ['AIRPORTCAMPUS']).whole, true);
  assert.equal(adhocProblem({ campuses: [], grade: '7', all: true, divisions: [] }), 'Choose at least one campus.');
  assert.equal(adhocProblem({ campuses: ['CITYCAMPUS'], grade: '7', all: false, divisions: ['B'] }), null);
});

test('admin weekly slot + teacher start send a campuses list', () => {
  assert.match(src('app/admin/timetable/page.tsx'), /<CampusesPicker/);
  assert.match(src('app/teacher/dashboard/page.tsx'), /campuses: adhoc\.campuses/);
  assert.match(src('lib/teacherStartSchema.ts'), /campuses/);
});

test('timetable clash across a shared campus', () => {
  const base: ClashSlot = { id: 'a', teacherId: 't1', campus: 'AIRPORTCAMPUS', campuses: ['AIRPORTCAMPUS', 'CITYCAMPUS'], grade: '7', divisions: ['A'], allDivisions: false, weekday: 1, start: '09:00', end: '10:00', effectiveFrom: null, effectiveTo: null };
  assert.equal(slotsClash(base, { ...base, id: 'b', teacherId: 't2', campus: 'CITYCAMPUS', campuses: [] }), true);
  assert.equal(slotsClash(base, { ...base, id: 'c', teacherId: 't2', campus: 'HILLCAMPUS', campuses: [] }), false);
});

test('teacher assignments: campuses × divisions in one add', () => {
  const out = addAssignments([], ['AIRPORTCAMPUS', 'CITYCAMPUS'], '7', { all: false, divisions: ['A', 'B'] });
  assert.equal(out.length, 4);
  const all = addAssignments(out, ['CITYCAMPUS'], '7', { all: true, divisions: [] });
  assert.deepEqual(all.filter((a) => a.campus === 'CITYCAMPUS').map((a) => a.division), ['*']);
  assert.equal(addAssignments(all, [], '7', { all: true, divisions: [] }).length, all.length);
});

// Grade steering
test('grades read "Grade 7" and sort numerically', () => {
  assert.deepEqual(gradeInput('7'), { name: '7', label: 'Grade 7' });
  assert.equal(newGradeSortOrder('7', []), 70);
  assert.equal(newGradeSortOrder('KG', [{ sortOrder: 100 }]), 110);
  const sorted = sortGradeOptions([{ name: '10', sortOrder: 100 }, { name: '7', sortOrder: 999 }, { name: '6', sortOrder: 60 }]);
  assert.deepEqual(sorted.map((g) => g.name), ['6', '7', '10']);
  const mig = fs.readFileSync(path.join(__dirname, '..', 'prisma/migrations/20261125170100_grade_labels/migration.sql'), 'utf8');
  assert.match(mig, /'Grade '/);
  assert.doesNotMatch(src('components/admin/GradePickers.tsx'), /\$\{g\.label\} \(\$\{g\.name\}\)/);
});

// Item 7
test('video pane snaps to 16:9 tiles and always fits the 2/4/6 header', () => {
  const fit = fitPaneToTiles({ w: 400, h: 600 }, 1, 2);
  assert.ok(fit.paneW >= PEER_HEADER_MIN_W);
  assert.ok(Math.abs(fit.tileH - Math.floor((fit.tileW * 9) / 16)) <= 1);
  assert.equal(fit.paneH, 34 + 16 + 2 * fit.tileH + 6);
  const tiny = fitPaneToTiles({ w: 120, h: 200 }, 1, 2);
  assert.equal(tiny.paneW, PEER_HEADER_MIN_W);
  const box = compactWhiteboardVideo({ x: 0, y: 0, w: 1300, h: 760 });
  assert.ok(box.w >= PEER_HEADER_MIN_W);
});

test('floats re-clamp when the meeting bar appears and never go under it', () => {
  const fp = src('components/classroom/FloatingPanel.tsx');
  assert.match(fp, /FLOAT_BOUNDS_EVENT/);
  assert.match(fp, /maxWidth: maxW/);
  assert.match(src('components/classroom/MeetingBar.tsx'), /notifyFloatBounds\(\)/);
});

// Item 8
test('readable student place label', () => {
  const labels = { campuses: [{ name: 'AIRPORTCAMPUS', label: 'Airport Campus' }], grades: [{ name: '7', label: 'Grade 7', divisions: [{ name: 'A', label: 'Foundation A' }] }] };
  assert.equal(studentPlaceLabel({ campus: 'AIRPORTCAMPUS', grade: '7', division: 'A' }, labels), 'Airport Campus · Grade 7 · Foundation A');
});

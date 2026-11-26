/** Student-video pages replace the random 8-second rotation (lib/videoPages). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { pagingOrder, stepPage, videoPageLayout, type PageCandidate } from '../src/lib/videoPages';

const src = (p: string) => readFileSync(`src/${p}`, 'utf8');
const kid = (n: number, camOn = true): PageCandidate => ({ identity: `student_${n}`, name: `Student ${n}`, camOn });
const twelve = Array.from({ length: 12 }, (_, i) => kid(i + 1));

test('pages follow roster (natural name) order and hold `max` students', () => {
  const p0 = videoPageLayout({ candidates: twelve, teacherPins: [], max: 5, page: 0 });
  assert.deepEqual(p0.visible, ['student_1', 'student_2', 'student_3', 'student_4', 'student_5']);
  assert.equal(p0.pages, 3);
  assert.equal(p0.total, 12);
  const p2 = videoPageLayout({ candidates: twelve, teacherPins: [], max: 5, page: 2 });
  assert.deepEqual(p2.visible, ['student_11', 'student_12']);
  // Same input, same answer: recomputing never reshuffles.
  assert.deepEqual(videoPageLayout({ candidates: [...twelve].reverse(), teacherPins: [], max: 5, page: 0 }).visible, p0.visible);
});

test('only camera-on students are paged; the page is clamped when students leave', () => {
  const some = twelve.map((c, i) => (i % 2 ? { ...c, camOn: false } : c));
  const l = videoPageLayout({ candidates: some, teacherPins: [], max: 5, page: 9 });
  assert.equal(l.total, 6);
  assert.equal(l.pages, 2);
  assert.equal(l.page, 1);
  assert.deepEqual(l.visible, ['student_11']);
  const none = videoPageLayout({ candidates: twelve.map((c) => ({ ...c, camOn: false })), teacherPins: [], max: 5, page: 3 });
  assert.deepEqual(none.visible, []);
  assert.equal(none.pages, 1);
  assert.equal(none.page, 0);
});

test('teacher pins keep a tile on every page; the page holds the remaining tiles', () => {
  const pins = [{ identity: 'student_9', pinnedAt: 1 }];
  const p0 = videoPageLayout({ candidates: twelve, teacherPins: pins, max: 5, page: 0 });
  assert.deepEqual(p0.visible, ['student_9', 'student_1', 'student_2', 'student_3', 'student_4']);
  assert.equal(p0.pageSize, 4);
  assert.equal(p0.total, 11);
  assert.equal(p0.pages, 3);
  const p2 = videoPageLayout({ candidates: twelve, teacherPins: pins, max: 5, page: 2 });
  assert.deepEqual(p2.visible, ['student_9', 'student_10', 'student_11', 'student_12']);
  // Every slot pinned: one page, pins only.
  const all = videoPageLayout({ candidates: twelve, teacherPins: [1, 2, 3].map((n) => ({ identity: `student_${n}`, pinnedAt: n })), max: 3, page: 4 });
  assert.deepEqual(all.visible, ['student_1', 'student_2', 'student_3']);
  assert.equal(all.pages, 1);
  // Never more than `max` publish.
  for (let page = 0; page < 4; page++) {
    assert.ok(videoPageLayout({ candidates: twelve, teacherPins: pins, max: 6, page }).visible.length <= 6);
  }
});

test('natural order: "Student 2" before "Student 10"; equal names stay stable by identity', () => {
  assert.deepEqual(pagingOrder([kid(10), kid(2), kid(1)]), ['student_1', 'student_2', 'student_10']);
  assert.deepEqual(
    pagingOrder([{ identity: 'b', name: 'Asha', camOn: true }, { identity: 'a', name: 'Asha', camOn: true }]),
    ['a', 'b'],
  );
});

test('Prev / Next wrap around', () => {
  assert.equal(stepPage(0, 3, 1), 1);
  assert.equal(stepPage(2, 3, 1), 0);
  assert.equal(stepPage(0, 3, -1), 2);
  assert.equal(stepPage(5, 3, 1), 0); // clamped first
  assert.equal(stepPage(0, 1, 1), 0);
});

test('no random rotation is left: server pages, client follows the server order', () => {
  const sample = src('lib/sample.ts');
  assert.match(sample, /videoPageLayout\(/);
  assert.doesNotMatch(sample, /Math\.random|shuffle|allocateSample/);
  // Speaking no longer touches the page: the speaker-pin path is gone.
  assert.doesNotMatch(sample, /pinSpeaker|pinnedSpeakers/);
  assert.ok(!existsSync('src/app/api/rooms/[code]/sample/pin/route.ts'));
  assert.ok(!existsSync('src/app/api/sample/rotate/route.ts'));
  assert.doesNotMatch(src('components/classroom/ClassroomRoom.tsx'), /'\/sample\/pin'/);
  const panel = src('components/classroom/TeacherPeersFloat.tsx');
  assert.doesNotMatch(panel, /Math\.random|setRotationTick|rotationTick/);
  assert.match(panel, /videoPage\?\.order/);
  assert.match(panel, /data-testid="videos-prev"/);
  assert.match(panel, /data-testid="videos-next"/);
  const room = src('components/classroom/ClassroomRoom.tsx');
  assert.match(room, /roomFetch\(code, '\/video-page'/);
  assert.match(room, /videoPage=\{state\?\.videoPage \?\? null\}/);
  const api = src('app/api/rooms/[code]/video-page/route.ts');
  assert.match(api, /getTeacherSession/);
  assert.match(api, /room\.teacherId !== teacher\.id/);
  assert.match(src('app/api/rooms/[code]/state/route.ts'), /videoPage: isTeacher \? await getVideoPageInfo\(code\) : undefined/);
  // A camera turned on or off refreshes the page (coalesced per room).
  assert.match(src('lib/teacherMute.ts'), /schedulePageRefresh\(room\.code\)/);
});

// ---------------------------------------------------------------- teacher video layout (Nov 26)
import { fillGridLayout, nextOverlaySlots } from '../src/lib/videoGrid';
import { handOrder, ordinal } from '../src/lib/handOrder';

test('class home grid: biggest 16:9 tiles that fit the stage, every tile the same size', () => {
  const one = fillGridLayout(1, 1280, 720);
  assert.equal(one.cols, 1);
  assert.ok(one.tileW > 1000);
  const two = fillGridLayout(2, 1280, 720);
  assert.equal(two.cols, 2); // side by side on a wide stage
  const six = fillGridLayout(6, 1280, 720);
  assert.equal(six.cols, 3);
  assert.equal(six.rows, 2);
  const tall = fillGridLayout(6, 400, 900); // portrait / narrow
  assert.equal(tall.cols, 1);
  for (const g of [one, two, six, tall]) {
    assert.ok(Math.abs(g.tileH - (g.tileW * 9) / 16) <= 1);
    assert.ok(g.cols * g.tileW + (g.cols - 1) * g.gap <= g.paneW);
  }
  assert.equal(fillGridLayout(0, 0, 0).tileW, 0);
});

test('share / whiteboard window cycles 2 → 4 → 6 → 2', () => {
  assert.equal(nextOverlaySlots(2), 4);
  assert.equal(nextOverlaySlots(4), 6);
  assert.equal(nextOverlaySlots(6), 2);
});

test('roster hand badges number raises in order', () => {
  const m = handOrder([
    { id: 'a', handRaised: true, handRaisedAt: 30 },
    { id: 'b', handRaised: false },
    { id: 'c', handRaised: true, handRaisedAt: 10 },
    { id: 'd', handRaised: true, handRaisedAt: null },
  ]);
  assert.deepEqual([...m.entries()], [['c', 1], ['a', 2], ['d', 3]]);
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st']);
});

test('teacher layout wiring: fill on the class home, 2/4/6 window + close while sharing, one Leave/End menu, Roster label', () => {
  const room = src('components/classroom/ClassroomRoom.tsx');
  assert.match(room, /const videoOverlay = isTeacher && \(shareLayout \|\| wbOpen\)/);
  assert.match(room, /fill=\{!videoOverlay\}/);
  assert.match(room, /onCycleSlots=\{\(\) => setOverlaySlots\(\(n\) => nextOverlaySlots\(n\)\)\}/);
  assert.match(room, /onClose=\{closeVideoWindow\}/);
  assert.match(room, /setOverlaySlots\(2\)/); // every share / whiteboard starts at 2
  assert.match(room, /studentCapForSlots\(teacherSlots\)/); // server cap follows what is on screen
  const panel = src('components/classroom/TeacherPeersFloat.tsx');
  assert.match(panel, /const isMin = false;/);
  assert.doesNotMatch(panel, /data-testid="videos-min"|videos-layout-/);
  const controls = src('components/classroom/Controls.tsx');
  assert.match(controls, /caption="Roster"/);
  assert.doesNotMatch(controls, /caption="People"|Next videos/);
  assert.match(controls, /<LeaveEndMenu/);
  assert.doesNotMatch(controls, />\s*End class\s*</);
  const bar = src('components/classroom/MeetingBar.tsx');
  assert.match(bar, /<LeaveEndMenu onLeave=\{onLeave\} onEnd=\{onEndClass\}/);
  assert.match(bar, /icon: ic\(<IconUsers size=\{18\} \/>\)/);
  assert.match(src('components/classroom/TeacherShareHud.tsx'), /aria-label=\{rosterShown \? 'Close roster' : 'Open roster'\}/);
  // Roster: hands first (sortRoster) with a numbered badge in both rosters.
  assert.match(room, /data-testid="roster-hand"/);
  assert.match(src('components/classroom/TeacherShareHud.tsx'), /tsh-hand-badge/);
});

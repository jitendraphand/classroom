/** Student-video pages replace the random 8-second rotation (lib/videoPages). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  // A speaker no longer evicts anyone from the page the teacher is looking at.
  const pin = sample.slice(sample.indexOf('export async function pinSpeaker'), sample.indexOf('export async function unpinSpeakerByParticipant'));
  assert.doesNotMatch(pin, /keys\.visible\(roomCode\), \.\.\.|pipe\.sadd/);
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
  // Older / native "rotate" buttons move to the next page.
  assert.match(src('app/api/sample/rotate/route.ts'), /moveVideoPage\(code, \{ delta: 1 \}\)/);
  assert.match(src('app/api/rooms/[code]/state/route.ts'), /videoPage: isTeacher \? await getVideoPageInfo\(code\) : undefined/);
  // A camera turned on or off refreshes the page (coalesced per room).
  assert.match(src('lib/teacherMute.ts'), /schedulePageRefresh\(room\.code\)/);
});

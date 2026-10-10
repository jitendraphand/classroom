import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { camWanted, effectiveCamWanted, panelShown } from '../src/lib/camOnDemand';
import { nextDataSaver, parseDataSaver, teacherVideoDemand } from '../src/lib/dataSaver';
import { mergeAudience } from '../src/lib/pollPolicy';

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');

test('cameras on demand: sample AND panel shown; teachers and old servers unaffected', () => {
  assert.equal(camWanted({ isTeacher: false, inSample: true, panelRaw: null }), true);
  assert.equal(camWanted({ isTeacher: false, inSample: true, panelRaw: '0' }), false);
  assert.equal(camWanted({ isTeacher: false, inSample: false, panelRaw: null }), false);
  assert.equal(camWanted({ isTeacher: true, inSample: false, panelRaw: '0' }), true);
  assert.equal(effectiveCamWanted({ canPublishVideo: true }), true); // server without camWanted
  assert.equal(effectiveCamWanted({ canPublishVideo: true, camWanted: false }), false);
  assert.equal(effectiveCamWanted({ canPublishVideo: false, camWanted: true }), false);
  assert.equal(panelShown({ minimized: false, portalHidden: false }), true);
  assert.equal(panelShown({ minimized: true, portalHidden: false }), false);
  assert.equal(panelShown({ minimized: false, portalHidden: true }), false);
});

test('cameras on demand: state, route and client wiring', () => {
  const state = src('app/api/rooms/[code]/state/route.ts');
  assert.match(state, /camWanted: camWanted\(/);
  assert.match(state, /canPublishVideo,\n/); // still sent for the Windows app
  const route = src('app/api/rooms/[code]/video-panel/route.ts');
  assert.match(route, /getTeacherSession/);
  assert.match(route, /redis\.del\(keys\.videoPanel/);
  const room = src('components/classroom/ClassroomRoom.tsx');
  assert.match(room, /track\.pauseUpstream\(\)/);
  assert.match(room, /track\.resumeUpstream\(\)/);
  assert.match(room, /'\/video-panel'/);
});

test('data saver cycles and maps to subscriptions', () => {
  assert.equal(parseDataSaver('x'), 'off');
  assert.equal(nextDataSaver('off'), 'low');
  assert.equal(nextDataSaver('low'), 'share-only');
  assert.equal(nextDataSaver('share-only'), 'off');
  assert.deepEqual(teacherVideoDemand({ mode: 'off', camPaneMinimized: false }), { cameraEnabled: true, cameraLow: false, shareLow: false });
  assert.deepEqual(teacherVideoDemand({ mode: 'low', camPaneMinimized: false }), { cameraEnabled: true, cameraLow: true, shareLow: true });
  assert.equal(teacherVideoDemand({ mode: 'share-only', camPaneMinimized: false }).cameraEnabled, false);
  assert.equal(teacherVideoDemand({ mode: 'off', camPaneMinimized: true }).cameraEnabled, false);
  assert.match(src('components/classroom/Controls.tsx'), /onCycleDataSaver/);
});

test('targeted nudges merge; all wins', () => {
  assert.equal(mergeAudience('teacher', 'all'), 'all');
  assert.equal(mergeAudience(undefined, 'teacher'), 'teacher');
  assert.deepEqual(mergeAudience({ participantIds: ['a'] }, { participantIds: ['b', 'a'] }), { participantIds: ['a', 'b'] });
  assert.deepEqual(mergeAudience('teacher', { participantIds: ['a'] }), { participantIds: ['a'] });
  assert.match(src('app/api/rooms/[code]/hand/route.ts'), /participantIds: \[participant\.id\]/);
});

test('audio: student mic speech + DTX without RED; share audio music without DTX', () => {
  const room = src('components/classroom/ClassroomRoom.tsx');
  assert.match(room, /audioPreset: AudioPresets\.speech,\s*dtx: true,[\s\S]{0,300}red: isTeacher/);
  assert.match(room, /audioPreset: AudioPresets\.music,\s*dtx: false/);
});

test('adaptive stream + dynacast on; video mode manual and off by default', () => {
  const room = src('components/classroom/ClassroomRoom.tsx');
  assert.match(room, /adaptiveStream: \{/);
  assert.match(room, /dynacast: true/);
  assert.match(room, /useState\(false\);\n/);
  assert.doesNotMatch(room, /share_video_mode/);
});

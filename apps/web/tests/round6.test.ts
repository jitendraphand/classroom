import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emptyDoc, isOwnRelayEcho, applyOp, type Op } from '../src/lib/whiteboard/model';
import { WhiteboardSession, b64ToPackets, packetsToB64, opsPackets } from '../src/lib/whiteboard/session';
import { layerKey } from '../src/lib/whiteboard/render';
import { DUCK_GAIN, DUCK_IDLE, HOLD_MS, duckStep, rmsDb } from '../src/lib/micDuck';
import { classroomViewSource } from './helpers/classroomSource';

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');

test('item 4: a student never re-applies its own relayed stroke (no doubled points)', async () => {
  const me = 'student_abc';
  const student = new WhiteboardSession(emptyDoc(), true);
  const pg = student.doc.pages[0]!.id;
  const add: Op = { k: 'add', p: pg, item: { k: 'stroke', id: 's1', by: me, tool: 'pen', c: '#000', w: 4, pts: [0, 0] } };
  const pts: Op = { k: 'pts', p: pg, id: 's1', pts: [10, 10, 20, 20] };
  student.apply([add, pts]); // drawn locally
  const relayed = { v: 1 as const, t: 'ops' as const, ops: [add, pts], by: me };
  assert.equal(isOwnRelayEcho(relayed, me), true);
  if (!isOwnRelayEcho(relayed, me)) for (const b of opsPackets(relayed.ops)) await student.receive(b);
  const s = student.doc.pages[0]!.items[0] as { pts: number[] };
  assert.deepEqual(s.pts, [0, 0, 10, 10, 20, 20], 'points exactly once');
  // Another student's relayed strokes are still applied.
  assert.equal(isOwnRelayEcho({ t: 'ops', by: 'student_other' }, me), false);
  assert.equal(isOwnRelayEcho({ t: 'snap' }, me), false);
  // Without the filter the bug: pts appended twice.
  const d = emptyDoc();
  applyOp(d, { ...add, p: d.pages[0]!.id } as Op);
  applyOp(d, { ...pts, p: d.pages[0]!.id } as Op);
  applyOp(d, { ...pts, p: d.pages[0]!.id } as Op);
  assert.equal((d.pages[0]!.items[0] as { pts: number[] }).pts.length, 10);
  assert.match(src('components/classroom/Whiteboard.tsx'), /isOwnRelayEcho\(p, identityRef\.current\)/);
});

test('whiteboard CPU: pts-only changes keep the cached layer; structure changes rebuild it', () => {
  const s = new WhiteboardSession(emptyDoc(), true);
  const pg = s.doc.pages[0]!.id;
  s.apply([{ k: 'add', p: pg, item: { k: 'stroke', id: 'a', by: 't', tool: 'pen', c: '#000', w: 4, pts: [0, 0] } }], 1000);
  const v0 = s.structVersion;
  s.apply([{ k: 'pts', p: pg, id: 'a', pts: [5, 5] }], 1010);
  s.apply([{ k: 'pts', p: pg, id: 'a', pts: [6, 6] }], 1020);
  assert.equal(s.structVersion, v0, 'growing a stroke is not a structural change');
  assert.deepEqual([...s.hotIds(1100)], ['a']);
  assert.deepEqual([...s.hotIds(5000)], [], 'cools down');
  const view = { scale: 1, tx: 0, ty: 0 };
  const k = (hot: string[]) => layerKey({ pageId: pg, bg: 'white', structVersion: s.structVersion, hot, v: view, W: 100, H: 50 });
  assert.equal(k(['a']), k(['a']));
  assert.notEqual(k(['a']), k([]));
  const board = src('lib/whiteboard/WhiteboardBoard.tsx');
  assert.match(board, /requestAnimationFrame/);
  assert.match(board, /document\.hidden/);
  assert.match(board, /LayeredRenderer/);
});

test('multi-server: snapshot packets survive the base64 round trip (Redis copy)', async () => {
  const s = new WhiteboardSession(emptyDoc(), true);
  const pg = s.doc.pages[0]!.id;
  s.apply([{ k: 'add', p: pg, item: { k: 'stroke', id: 'z', by: 't', tool: 'pen', c: '#123456', w: 4, pts: [1, 2, 3, 4] } }]);
  const back = b64ToPackets(packetsToB64(await s.snapshotPackets()));
  const viewer = new WhiteboardSession(undefined, false);
  for (const b of back) await viewer.receive(b);
  assert.equal(viewer.ready, true);
  assert.deepEqual(viewer.doc.pages[0]!.items, s.doc.pages[0]!.items);
  const route = src('app/api/rooms/[code]/whiteboard/route.ts');
  assert.match(route, /'snap', 'stored'/);
  assert.match(route, /clearStoredSnapshot/);
});

test('B1: mic ducking while computer sound is loud, talk-over passes, no flutter', () => {
  let st = DUCK_IDLE;
  st = duckStep(st, -20, -31, 0); // video playing, only speaker bleed in the mic
  assert.equal(st.gain, DUCK_GAIN);
  assert.equal(st.everDucked, true);
  st = duckStep(st, -60, -50, 100); // video paused: held
  assert.equal(st.gain, DUCK_GAIN);
  st = duckStep(st, -60, -50, 100 + HOLD_MS + 1);
  assert.equal(st.gain, 1, 'released after the hold');
  st = duckStep(st, -20, -15, 1000); // teacher talks over the video
  assert.equal(st.gain, 1);
  assert.equal(duckStep(DUCK_IDLE, -70, -31, 0).gain, 1, 'no computer sound: never ducked');
  assert.ok(Math.abs(rmsDb([0.5, -0.5, 0.5, -0.5]) - -6.02) < 0.01);
});

test('B1 simulated (report approach): bleed of the video in the mic drops by ~20 dB', () => {
  // Video sound (sys) at -20 dBFS; mic = 0.025 x sys delayed 15 ms (≈ −32 dBFS, as measured live) + room noise.
  const sr = 8000, n = sr * 4, frame = sr / 20;
  const sys = Float32Array.from({ length: n }, (_, i) => 0.14 * Math.sin((2 * Math.PI * 330 * i) / sr) * (1 + 0.3 * Math.sin(i / 900)));
  const mic = Float32Array.from({ length: n }, (_, i) => 0.025 * (sys[i - 120] ?? 0) + 0.0005 * Math.sin(i * 1.7));
  let st = DUCK_IDLE;
  const out = new Float32Array(n);
  for (let f = 0; f < n / frame; f++) {
    const a = f * frame, b = a + frame;
    st = duckStep(st, rmsDb(sys.subarray(a, b)), rmsDb(mic.subarray(a, b)), f * 50);
    for (let i = a; i < b; i++) out[i] = mic[i]! * st.gain;
  }
  const corr = (x: Float32Array, y: Float32Array) => {
    let xy = 0, xx = 0;
    for (let i = 0; i < x.length; i++) { xy += x[i]! * y[i]!; xx += y[i]! * y[i]!; }
    return xy / xx;
  };
  const before = rmsDb(mic), after = rmsDb(out);
  assert.ok(before - after > 18, `bleed level ${before.toFixed(1)} → ${after.toFixed(1)} dBFS`);
  assert.ok(corr(out, sys) < corr(mic, sys) * 0.15);
});

test('B5: portrait phones get the student controls in a bottom row', () => {
  const css = src('app/globals.css');
  assert.match(css, /@media \(orientation: portrait\) and \(max-width: 700px\)[\s\S]*?\.stage-float-chrome\.is-rail > \.control-rail > div \{\s*flex-direction: row;/);
});

test('item 3: whiteboard uses the same floating video panel as a screen share', () => {
  const room = classroomViewSource();
  assert.match(room, /dock=\{wbOpen \? null : dockArea\}/);
  assert.match(room, /minLeft=\{wbOpen \? WB_TOOL_CLEAR_PX : 0\}/);
  assert.match(room, /whiteboard=\{wbOpen\}/);
  assert.match(room, /useMicDuck\(isTeacher/);
});

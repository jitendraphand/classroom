import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshTakeovers, isSecondDevice, parseTakeovers, takeoverToastText } from '../src/lib/deviceTakeover';
import { finishCopy, finishFromState } from '../src/lib/classFinish';
import { createEraseBatcher, eraseBatchBodies, ERASE_BATCH_MAX } from '../src/lib/eraseBatch';
import { isSmallScreen, shareLayerFor, shouldDeclineVp9, withoutVp9 } from '../src/lib/subscriberCodecs';
import { createStepUp } from '../src/lib/reconnectQuality';
import { decodeCached, encodeCached } from '../src/lib/dbCache';
import { SHARE_CODEC } from '../src/lib/videoQuality';

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
const root = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

function clock() {
  let t = 0;
  let id = 0;
  const q: { at: number; fn: () => void; id: number }[] = [];
  return {
    schedule: (fn: () => void, ms: number) => (q.push({ at: t + ms, fn, id: ++id }), id),
    cancel: (h: unknown) => {
      const i = q.findIndex((x) => x.id === h);
      if (i >= 0) q.splice(i, 1);
    },
    advance(ms: number) {
      t += ms;
      for (const x of q.filter((x) => x.at <= t)) {
        q.splice(q.indexOf(x), 1);
        x.fn();
      }
    },
  };
}

test('1. one device per SID: second device = different cookie; toast notices', () => {
  assert.equal(isSecondDevice({ cookieToken: 'a', seatToken: 'a', seatStatus: 'ADMITTED' }), false);
  assert.equal(isSecondDevice({ cookieToken: null, seatToken: 'a', seatStatus: 'ADMITTED' }), true);
  assert.equal(isSecondDevice({ cookieToken: 'b', seatToken: 'a', seatStatus: 'WAITING' }), true);
  assert.equal(isSecondDevice({ cookieToken: 'b', seatToken: 'a', seatStatus: 'LEFT' }), false);
  const now = 1_000_000;
  const list = parseTakeovers(
    [JSON.stringify({ participantId: 'p', displayName: 'Asha', at: now - 1000 }), JSON.stringify({ participantId: 'q', displayName: 'Old', at: now - 10 * 60_000 }), 'junk'],
    now
  );
  assert.deepEqual(list.map((t) => t.displayName), ['Asha']);
  assert.equal(freshTakeovers(list, now - 500).length, 0);
  assert.equal(freshTakeovers(list, now - 5000).length, 1);
  assert.match(takeoverToastText(list[0]!), /Asha joined from another device/);
  const svc = src('lib/studentService.ts');
  assert.match(svc, /isSecondDevice\(\{ cookieToken: await getStudentSessionToken\(\)/);
  assert.match(src('lib/deviceTakeoverServer.ts'), /set\(keys\.replacedToken\(oldToken\), '1'/);
  const state = src('app/api/rooms/[code]/state/route.ts');
  assert.match(state, /replaced: true/);
  assert.match(state, /takeovers: isTeacher \? await recentTakeovers\(code\)/);
  assert.match(src('components/classroom/ClassroomRoom.tsx'), /data-testid="takeover-toast"/);
});

test('2. finished student view: reasons, copy, static screen, window.close', () => {
  assert.equal(finishFromState({ public: true, replaced: true }), 'replaced');
  assert.equal(finishFromState({ status: 'ENDED' }), 'ended');
  assert.equal(finishFromState({ public: true, meLeft: true }), 'removed');
  assert.equal(finishFromState({ status: 'LIVE' }), null);
  assert.equal(finishCopy('replaced').title, 'You joined from another device');
  assert.match(finishCopy('ended').body, /close this tab/);
  const room = src('components/classroom/ClassroomRoom.tsx');
  assert.match(room, /function StudentFinished/);
  assert.match(room, /window\.close\(\)/);
  assert.match(room, /onFinished\('left'\)/);
  assert.match(room, /DisconnectReason\.DUPLICATE_IDENTITY \? 'replaced' : 'removed'/);
  assert.match(src('hooks/useRoomState.ts'), /data\.public && \(data\.replaced \|\| data\.meLeft\)/);
  assert.match(src('components/auth/StaffSessionGuard.tsx'), /CLASS_FINISHED_EVENT/);
});

test('3/8. phones decline VP9 (H.264 backup at 720p); hw-aware elsewhere; explicit LOW cap', () => {
  const phone = { coarse: true, screenW: 412, screenH: 915 };
  const laptop = { coarse: false, screenW: 1920, screenH: 1080 };
  assert.equal(isSmallScreen(phone), true);
  assert.equal(isSmallScreen(laptop), false);
  assert.equal(shareLayerFor(phone, false), 'low');
  assert.equal(shareLayerFor(laptop, false), 'high');
  assert.equal(shareLayerFor(laptop, true), 'low');
  assert.equal(shouldDeclineVp9({ small: true, vp9Efficient: true, h264Efficient: true, h264Supported: true }), true);
  assert.equal(shouldDeclineVp9({ small: true, vp9Efficient: null, h264Efficient: null, h264Supported: false }), false);
  assert.equal(shouldDeclineVp9({ small: false, vp9Efficient: false, h264Efficient: true, h264Supported: true }), true);
  assert.equal(shouldDeclineVp9({ small: false, vp9Efficient: true, h264Efficient: true, h264Supported: true }), false);
  const codecs = [{ mimeType: 'video/VP9' }, { mimeType: 'video/H264' }, { mimeType: 'video/rtx' }, { mimeType: 'video/AV1' }];
  assert.deepEqual(withoutVp9(codecs).map((c) => c.mimeType), ['video/H264', 'video/rtx']);
  assert.deepEqual(withoutVp9([{ mimeType: 'video/VP9' }]).map((c) => c.mimeType), ['video/VP9']);
  assert.equal(SHARE_CODEC.backupCodec, 'vp8');
  assert.match(src('components/classroom/TeacherMediaDemand.tsx'), /shareLayerFor\(screen, base\.shareLow\)/);
});

test('4. batch eraser: bodies, dedupe, one request per flush; route accepts ids[]', () => {
  const ids = Array.from({ length: 120 }, (_, i) => `s${i}`);
  const bodies = eraseBatchBodies([...ids, 's1', '']);
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0]!.ids.length, ERASE_BATCH_MAX);
  const c = clock();
  const sent: string[][] = [];
  const b = createEraseBatcher(async (body) => void sent.push(body.ids), { schedule: c.schedule });
  b.add(['a', 'b']);
  b.add(['b', 'c']);
  c.advance(200);
  b.add(['a']);
  c.advance(200);
  assert.deepEqual(sent, [['a', 'b', 'c']]);
  assert.equal(b.requests(), 1);
  const route = src('app/api/rooms/[code]/draw/route.ts');
  assert.match(route, /ids: z\.array\(z\.string\(\)\.max\(40\)\)\.max\(ERASE_BATCH_MAX\)/);
  assert.match(route, /deleteStrokes\(code, ids\)/);
  assert.match(route, /await deleteStroke\(code, body\.id\)/); // single delete kept
  assert.match(src('lib/drawServer.ts'), /export async function deleteStrokes/);
});

test('5/7. Caddy compression + caching; TURN cert mount', () => {
  const caddy = root('infra/Caddyfile');
  assert.match(caddy, /encode zstd gzip/);
  assert.match(caddy, /@immutable path \/_next\/static\/\*/);
  assert.match(caddy, /max-age=31536000, immutable/);
  assert.match(caddy, /header @api \?Cache-Control "no-store"/);
  assert.match(root('scripts/configure-domain-tls.sh'), /max-age=31536000, immutable/);
  assert.match(root('docker-compose.yml'), /caddy_data:\/caddy-data:ro/);
  assert.match(root('infra/livekit.example.yaml'), /tls_port: 5349/);
});

test('6. db cache: dates round-trip; writes bump the version; state route reads through it', () => {
  const v = { a: new Date('2026-10-10T10:00:00Z'), b: [{ c: new Date(0), d: 'x' }], e: null };
  const back = decodeCached<typeof v>(encodeCached(v));
  assert.ok(back.a instanceof Date && back.a.getTime() === v.a.getTime());
  assert.ok(back.b[0]!.c instanceof Date);
  assert.equal(back.e, null);
  assert.match(src('lib/db.ts'), /WRITES\.has\(params\.action\)\) noteDbWrite\(\)/);
  assert.match(src('lib/dbCacheVersion.ts'), /setTimeout\(\(\) => void bump\(\), 2000\)/);
  assert.match(src('app/api/rooms/[code]/state/route.ts'), /cachedRead\(`room-state:\$\{code\}`/);
  assert.match(src('lib/auth.ts'), /cachedRead\(`student-token:\$\{token\}`/);
});

test('8. reconnect: low while recovering, step up after a quiet period', () => {
  const c = clock();
  const phases: string[] = [];
  const s = createStepUp((p) => phases.push(p), { schedule: c.schedule, cancel: c.cancel, stepUpMs: 8000 });
  s.disturbed();
  s.connected();
  c.advance(5000);
  s.disturbed(); // flapping restarts
  s.connected();
  c.advance(7999);
  assert.equal(s.phase(), 'recovering');
  c.advance(1);
  assert.deepEqual(phases, ['recovering', 'stable']);
  const tmd = src('components/classroom/TeacherMediaDemand.tsx');
  assert.match(tmd, /RoomEvent\.Reconnecting/);
  assert.match(tmd, /addEventListener\('online'/);
});

test('8. chat UI is lazy-loaded; the thread hook is not', () => {
  const room = src('components/classroom/ClassroomRoom.tsx');
  assert.match(room, /const ChatView = dynamic\(\(\) => import\('\.\/Chat'\)/);
  assert.match(room, /import \{ useChatThread \} from '\.\/chatThread'/);
  assert.doesNotMatch(room, /from '\.\/Chat';/);
});

test('shared modules have no app-alias imports (Windows sync)', () => {
  for (const f of ['deviceTakeover', 'classFinish', 'eraseBatch', 'subscriberCodecs', 'reconnectQuality']) {
    assert.doesNotMatch(src(`lib/${f}.ts`), /from '@\//, f);
  }
});

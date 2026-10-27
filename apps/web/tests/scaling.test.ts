import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { withPoolParams } from '../src/lib/dbUrl';
import { LOCK_RELEASE_LUA } from '../src/lib/leaderLock';
import {
  applyDrawReqPush,
  applyHandPush,
  chatPacketTrusted,
  decodeSignalPacket,
  drawPacketTrusted,
  senderKind,
  signalPacketTrusted,
} from '../src/lib/realtimePackets';
import {
  DEFAULT_DB_POOL_PER_WORKER,
  DEFAULT_POSTGRES_MAX_CONNECTIONS,
  POSTGRES_HEADROOM,
  webWorkerCount,
  autoWebWorkers,
} from '../src/lib/webWorkers';

const src = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8');
const root = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('webWorkerCount: all CPUs on small boxes, half on big ones; caps to fit Postgres', () => {
  const auto = webWorkerCount({ env: {}, cpuCount: 8 });
  assert.equal(auto.workers, 8);
  assert.equal(auto.capped, false);
  const big = webWorkerCount({
    env: { POSTGRES_MAX_CONNECTIONS: '80', DB_POOL_PER_WORKER: '8' },
    cpuCount: 32,
  });
  assert.equal(big.workers, Math.floor((80 - POSTGRES_HEADROOM) / 8));
  assert.equal(big.capped, true);
  const explicit = webWorkerCount({ env: { WEB_WORKERS: '4' }, cpuCount: 32 });
  assert.equal(explicit.workers, 4);
  assert.equal(explicit.capped, false);
  // 32 vCPU: half the cores for web, LiveKit keeps the rest.
  const a1 = webWorkerCount({ env: {}, cpuCount: 32 });
  assert.equal(a1.workers, 16);
  assert.equal(a1.poolPerWorker, 10);
  // Trial box (32 OCPU = 64 vCPU): 32 workers × 10 connections.
  const a64 = webWorkerCount({ env: { WEB_WORKERS: 'auto' }, cpuCount: 64 });
  assert.equal(a64.workers, 32);
  assert.equal(a64.poolPerWorker, 10);
  assert.ok(a64.workers * a64.poolPerWorker <= DEFAULT_POSTGRES_MAX_CONNECTIONS - POSTGRES_HEADROOM);
  // Tunable split.
  assert.equal(webWorkerCount({ env: { WEB_CPU_FRACTION: '0.25' }, cpuCount: 64 }).workers, 16);
  assert.equal(webWorkerCount({ env: { WEB_CPU_FRACTION: 'junk' }, cpuCount: 64 }).workers, 32);
  assert.equal(webWorkerCount({ env: { WEB_CPU_FRACTION: '0.05' }, cpuCount: 64 }).workers, 8);
  assert.equal(autoWebWorkers(4), 4);
  assert.equal(autoWebWorkers(12), 8);
  // Old 280-connection deploys still fit: pool shrinks.
  const old = webWorkerCount({ env: { POSTGRES_MAX_CONNECTIONS: '280' }, cpuCount: 64 });
  assert.ok(old.workers * old.poolPerWorker <= 280 - POSTGRES_HEADROOM);
  // cluster.js mirrors these defaults.
  const cluster = root('cluster.js');
  assert.match(cluster, new RegExp(`DEFAULT_POOL = ${DEFAULT_DB_POOL_PER_WORKER};`));
  assert.match(cluster, new RegExp(`DEFAULT_MAX_CONN = ${DEFAULT_POSTGRES_MAX_CONNECTIONS};`));
  assert.match(cluster, /WEB_CPU_FRACTION/);
  const compose = readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8');
  assert.match(compose, new RegExp(`max_connections=\\$\\{POSTGRES_MAX_CONNECTIONS:-${DEFAULT_POSTGRES_MAX_CONNECTIONS}\\}`));
  assert.match(compose, /WEB_CPU_FRACTION/);
});

test('withPoolParams appends connection_limit and pool_timeout once', () => {
  const a = withPoolParams('postgresql://u:p@127.0.0.1:5432/db', {
    env: { DB_POOL_PER_WORKER: '8', DB_POOL_TIMEOUT: '10' },
  });
  assert.equal(a, 'postgresql://u:p@127.0.0.1:5432/db?connection_limit=8&pool_timeout=10');
  const b = withPoolParams('postgresql://u:p@127.0.0.1:5432/db?connection_limit=30', {
    env: { DB_POOL_TIMEOUT: '10' },
  });
  assert.equal(b, 'postgresql://u:p@127.0.0.1:5432/db?connection_limit=30&pool_timeout=10');
  const c = withPoolParams('postgresql://u:p@127.0.0.1:5432/db?connection_limit=4&pool_timeout=5');
  assert.equal(c, 'postgresql://u:p@127.0.0.1:5432/db?connection_limit=4&pool_timeout=5');
  assert.equal(DEFAULT_DB_POOL_PER_WORKER, 10);
  assert.equal(DEFAULT_POSTGRES_MAX_CONNECTIONS, 400);
  assert.ok(DEFAULT_POSTGRES_MAX_CONNECTIONS >= 200);
});

test('leader lock release is compare-and-delete', () => {
  assert.match(LOCK_RELEASE_LUA, /redis\.call\('get'/);
  assert.match(LOCK_RELEASE_LUA, /ARGV\[1\]/);
});

test('chat packets: server and teacher trusted; students cannot publish data at all', () => {
  const msg = { senderRole: 'STUDENT', scope: 'TEACHER', senderParticipantId: 's1' };
  assert.equal(senderKind(undefined), 'server');
  assert.equal(senderKind('teacher_x'), 'teacher');
  assert.equal(senderKind('student_x'), 'student');
  assert.equal(chatPacketTrusted({ senderIdentity: null, message: { senderRole: 'TEACHER', scope: 'BROADCAST' } }), true);
  assert.equal(chatPacketTrusted({ senderIdentity: null, message: msg }), true);
  assert.equal(
    chatPacketTrusted({ senderIdentity: 'teacher_1', message: { senderRole: 'TEACHER', scope: 'BROADCAST' } }),
    true
  );
  assert.equal(chatPacketTrusted({ senderIdentity: 'teacher_1', message: msg }), false);
  assert.equal(chatPacketTrusted({ senderIdentity: 'student_1', message: msg, identityParticipantId: 's1' }), false);
  assert.equal(
    chatPacketTrusted({ senderIdentity: 'student_1', message: { senderRole: 'TEACHER', scope: 'BROADCAST' } }),
    false
  );
});

test('signal packets: server and teacher only; mute stays off this topic', () => {
  const hand = decodeSignalPacket({ v: 1, type: 'hand', raised: true, participantId: 'p1' });
  assert.deepEqual(hand, { v: 1, type: 'hand', raised: true, participantId: 'p1' });
  assert.equal(decodeSignalPacket({ v: 1, type: 'mute', muted: true }), null);
  assert.equal(signalPacketTrusted(hand!, null, 'p1'), true);
  assert.equal(signalPacketTrusted(hand!, 'teacher_t', 'other'), true);
  assert.equal(signalPacketTrusted(hand!, 'student_s', 'p1'), false);
  assert.equal(signalPacketTrusted(hand!, 'student_s', 'other'), false);
  const req = decodeSignalPacket({ v: 1, type: 'draw-req', on: true, participantId: 'p1' });
  assert.equal(req?.type, 'draw-req');
});

test('hand and draw-request pushes update local state without a full snapshot', () => {
  const state = {
    me: { id: 'p1', handRaised: false, drawRequested: false },
    admitted: [
      { id: 'p1', handRaised: false, drawRequested: false },
      { id: 'p2', handRaised: false, drawRequested: false },
    ],
    raisedHands: [] as string[],
    drawRequestCount: 0,
  };
  const h = applyHandPush(state, 'p1', true);
  assert.equal(h.me?.handRaised, true);
  assert.deepEqual(h.raisedHands, ['p1']);
  const d = applyDrawReqPush(state, 'p2', true);
  assert.equal(d.drawRequestCount, 1);
  assert.equal(d.admitted[1]!.drawRequested, true);
});

test('draw overlay: only server-relayed or teacher packets (no student self-publishing)', () => {
  assert.equal(drawPacketTrusted({ senderIdentity: null, packet: { t: 'clear' } }), true);
  assert.equal(drawPacketTrusted({ senderIdentity: null, packet: { t: 'pts', by: 'student_a' } }), true);
  assert.equal(drawPacketTrusted({ senderIdentity: 'teacher_t', packet: { t: 'pts', by: 'teacher_t' } }), true);
  assert.equal(drawPacketTrusted({ senderIdentity: 'student_a', packet: { t: 'pts', by: 'student_a' } }), false);
  assert.equal(drawPacketTrusted({ senderIdentity: 'student_a', packet: { t: 'pts', by: 'student_b' } }), false);
  assert.equal(drawPacketTrusted({ senderIdentity: 'teacher_t__screen', packet: { t: 'clear' } }), false);
});

test('cluster entry, prisma pool, and redis leader keys are wired', () => {
  const cluster = root('cluster.js');
  assert.match(cluster, /WEB_WORKERS/);
  assert.match(cluster, /keepAliveTimeout/);
  assert.match(cluster, /headersTimeout/);
  assert.match(cluster, /require\(standalone\)/);
  const db = src('lib/db.ts');
  assert.match(db, /withPoolParams/);
  const rank = src('lib/rankScheduler.ts');
  assert.match(rank, /runIfLeader/);
  const presence = src('lib/teacherPresence.ts');
  assert.match(presence, /teacherAbsenceDue/);
  assert.match(presence, /startAbsenceSweeper/);
  const grant = src('lib/livekit.ts');
  assert.match(grant, /canPublishData: isTeacher/);
  const chat = src('components/classroom/chatThread.ts');
  assert.match(chat, /if \(pushLive\) \{/);
  const docker = root('Dockerfile');
  assert.match(docker, /cluster\.js/);
});

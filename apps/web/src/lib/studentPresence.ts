/** Server side of lib/studentPresenceLogic.ts (Redis + teacher nudges). */
import { ensureRedis, keys } from './redis';
import { nudgeRoomState } from './roomNudge';
import {
  HEARTBEAT_RECONNECTING_MS,
  HEARTBEAT_STALE_MS,
  STUDENT_GONE_GRACE_MS,
  applyHeartbeat,
  connectionPhase,
  nextLive,
  parseBeat,
  parseLive,
  type ConnectionPhase,
} from './studentPresenceLogic';

const TTL_S = 12 * 60 * 60;

type Watch = { reconnecting: ReturnType<typeof setTimeout>; stale: ReturnType<typeof setTimeout> };
const heartbeatWatches = new Map<string, Watch>();

function watchKey(code: string, identity: string) {
  return `${code}\0${identity}`;
}

/** Nudge the teacher when a beat turns "reconnecting". A late beat does not remove them. */
function armHeartbeatWatch(code: string, identity: string) {
  const key = watchKey(code, identity);
  const prev = heartbeatWatches.get(key);
  if (prev) {
    clearTimeout(prev.reconnecting);
    clearTimeout(prev.stale);
  }
  const reconnecting = setTimeout(() => {
    void nudgeIfHeartbeatPhase(code, identity, 'reconnecting');
  }, HEARTBEAT_RECONNECTING_MS + 50);
  const stale = setTimeout(() => {
    heartbeatWatches.delete(key);
    void nudgeIfHeartbeatPhase(code, identity, 'gone');
  }, HEARTBEAT_STALE_MS + 50);
  reconnecting.unref?.();
  stale.unref?.();
  heartbeatWatches.set(key, { reconnecting, stale });
}

async function nudgeIfHeartbeatPhase(code: string, identity: string, want: 'reconnecting' | 'gone') {
  try {
    const view = await studentRosterPresence(code);
    const gone = view.gone.has(identity);
    const reconnecting = view.reconnecting.has(identity);
    if (want === 'gone' && gone) nudgeRoomState(code, 'teacher');
    else if (want === 'reconnecting' && (reconnecting || gone)) nudgeRoomState(code, 'teacher');
  } catch {
    /* Redis blip: the teacher's slow poll still refreshes. */
  }
}

export async function recordStudentConnection(code: string, identity: string, kind: 'joined' | 'left', sid: string, at = Date.now()) {
  const r = await ensureRedis();
  const cur = parseLive(await r.hget(keys.studentLive(code), identity));
  const next = nextLive(cur, { kind, sid, at });
  if (!next) return;
  const multi = r.multi().hset(keys.studentLive(code), identity, JSON.stringify(next)).expire(keys.studentLive(code), TTL_S);
  if (kind === 'joined') {
    // Seed the beat so the roster can show "reconnecting" before the first
    // client heartbeat, and so a rejoin is not hidden by the previous beat.
    multi.hset(keys.studentHb(code), identity, String(at)).expire(keys.studentHb(code), TTL_S);
  }
  await multi.exec();
  if (kind === 'left') {
    // The roster drops them once the grace has passed: tell the teacher then.
    setTimeout(() => nudgeRoomState(code, 'teacher'), STUDENT_GONE_GRACE_MS).unref?.();
    setTimeout(() => nudgeRoomState(code, 'teacher'), STUDENT_GONE_GRACE_MS + 1500).unref?.();
  } else {
    armHeartbeatWatch(code, identity);
    nudgeRoomState(code, 'teacher');
  }
}

/**
 * Student client heartbeat. Identity is the session's, not the body's.
 * A beat from a different sid is ignored while this connection is still healthy.
 */
export async function recordStudentHeartbeat(code: string, identity: string, sid: string, at = Date.now()) {
  const r = await ensureRedis();
  const cur = parseLive(await r.hget(keys.studentLive(code), identity));
  const prevBeat = parseBeat(await r.hget(keys.studentHb(code), identity));
  const applied = applyHeartbeat(cur, prevBeat, { at, sid });
  if (applied.ignore) return;
  await r
    .multi()
    .hset(keys.studentLive(code), identity, JSON.stringify(applied.live))
    .expire(keys.studentLive(code), TTL_S)
    .hset(keys.studentHb(code), identity, String(applied.beat.at))
    .expire(keys.studentHb(code), TTL_S)
    .exec();
  armHeartbeatWatch(code, identity);
  if (applied.nudge) nudgeRoomState(code, 'teacher');
}

export async function studentRosterPresence(
  code: string,
  now = Date.now()
): Promise<{ gone: Set<string>; reconnecting: Set<string> }> {
  const r = await ensureRedis();
  const [liveAll, hbAll] = await Promise.all([r.hgetall(keys.studentLive(code)), r.hgetall(keys.studentHb(code))]);
  const ids = new Set([...Object.keys(liveAll ?? {}), ...Object.keys(hbAll ?? {})]);
  const gone = new Set<string>();
  const reconnecting = new Set<string>();
  for (const id of ids) {
    const phase: ConnectionPhase = connectionPhase(parseLive(liveAll?.[id]), parseBeat(hbAll?.[id]), now);
    if (phase === 'gone') gone.add(id);
    else if (phase === 'reconnecting') reconnecting.add(id);
  }
  return { gone, reconnecting };
}

/** LiveKit identities of students whose connection is gone (explicit leave, past the grace). */
export async function goneStudentIdentities(code: string, now = Date.now()): Promise<Set<string>> {
  return (await studentRosterPresence(code, now)).gone;
}

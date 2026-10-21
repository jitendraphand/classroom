/** Server side of lib/studentPresenceLogic.ts (Redis + teacher nudges). */
import { ensureRedis, keys } from './redis';
import { nudgeRoomState } from './roomNudge';
import { STUDENT_GONE_GRACE_MS, isGone, nextLive, parseLive } from './studentPresenceLogic';

const TTL_S = 12 * 60 * 60;

export async function recordStudentConnection(code: string, identity: string, kind: 'joined' | 'left', sid: string, at = Date.now()) {
  const r = await ensureRedis();
  const cur = parseLive(await r.hget(keys.studentLive(code), identity));
  const next = nextLive(cur, { kind, sid, at });
  if (!next) return;
  await r.multi().hset(keys.studentLive(code), identity, JSON.stringify(next)).expire(keys.studentLive(code), TTL_S).exec();
  if (kind === 'left') {
    // The roster drops them once the grace has passed: tell the teacher then.
    setTimeout(() => nudgeRoomState(code, 'teacher'), STUDENT_GONE_GRACE_MS).unref?.();
    setTimeout(() => nudgeRoomState(code, 'teacher'), STUDENT_GONE_GRACE_MS + 1500).unref?.();
  } else {
    nudgeRoomState(code, 'teacher');
  }
}

/** LiveKit identities of students whose connection is gone (past the grace). */
export async function goneStudentIdentities(code: string, now = Date.now()): Promise<Set<string>> {
  const r = await ensureRedis();
  const all = await r.hgetall(keys.studentLive(code));
  const out = new Set<string>();
  for (const [identity, raw] of Object.entries(all)) if (isGone(parseLive(raw), now)) out.add(identity);
  return out;
}

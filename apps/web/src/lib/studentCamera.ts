/**
 * Student camera state as reported by the student's client (POST
 * /api/rooms/[code]/camera and the heartbeat). Students outside the rotating
 * sample do not publish video, so LiveKit alone cannot say whether their
 * camera is on. Rules: lib/speakingRules.ts.
 */
import { ensureRedis, keys } from './redis';
import { parseCamFlag } from './speakingRules';

const TTL_S = 12 * 60 * 60;

/** Record the flag. Returns the previous value (false when unknown). */
export async function setStudentCam(code: string, identity: string, on: boolean): Promise<boolean> {
  const r = await ensureRedis();
  const [[, prev]] = (await r
    .multi()
    .hget(keys.studentCam(code), identity)
    .hset(keys.studentCam(code), identity, on ? '1' : '0')
    .expire(keys.studentCam(code), TTL_S)
    .exec()) as [[unknown, string | null], ...unknown[]];
  return parseCamFlag(prev);
}

export async function isStudentCamOn(code: string, identity: string): Promise<boolean> {
  const r = await ensureRedis();
  return parseCamFlag(await r.hget(keys.studentCam(code), identity));
}

/** identity → camera on, for the teacher's roster. */
export async function studentCamMap(code: string): Promise<Map<string, boolean>> {
  const r = await ensureRedis();
  const all = (await r.hgetall(keys.studentCam(code))) ?? {};
  return new Map(Object.entries(all).map(([id, v]) => [id, parseCamFlag(v)]));
}

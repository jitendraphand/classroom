/**
 * Waiting-room default per teacher. Every new class used to start with the
 * waiting room ON and the teacher had to turn it off each time (run 4 bug).
 * Now the last choice a teacher made (web roster, share HUD or the Windows
 * app; all go through PATCH /settings) is remembered in Redis and used for
 * the next class. Teachers who never chose get WAITING_ROOM_DEFAULT
 * ("on" | "off", default "on" so nothing changes for schools that rely on it).
 */
import { ensureRedis } from './redis';

const KEY = (teacherId: string) => `teacherpref:${teacherId}:waitingRoom`;
const TTL_S = 60 * 60 * 24 * 365;

export function envWaitingRoomDefault(raw = process.env.WAITING_ROOM_DEFAULT): boolean {
  return !/^(off|false|0|no)$/i.test((raw || '').trim());
}

/** Pure: stored "1"/"0" (or null) → the class-start value. */
export function resolveWaitingRoomDefault(stored: string | null | undefined, envDefault: boolean): boolean {
  if (stored === '1') return true;
  if (stored === '0') return false;
  return envDefault;
}

export async function waitingRoomDefaultFor(teacherId: string): Promise<boolean> {
  try {
    const r = await ensureRedis();
    return resolveWaitingRoomDefault(await r.get(KEY(teacherId)), envWaitingRoomDefault());
  } catch {
    return envWaitingRoomDefault();
  }
}

export async function rememberWaitingRoomChoice(teacherId: string, on: boolean): Promise<void> {
  try {
    const r = await ensureRedis();
    await r.set(KEY(teacherId), on ? '1' : '0', 'EX', TTL_S);
  } catch {
    /* best effort */
  }
}

/**
 * Whiteboard server side. The board itself lives on the teacher's device and
 * travels teacher → everyone over LiveKit data (topic `wb`). The server only:
 * - keeps the on/off flag (Redis) so /state tells late students to show it;
 * - relays snapshot requests (students and admins cannot publish data) to
 *   the teacher;
 * - relays student annotation ops after checking the existing draw
 *   permission (lib/drawServer holders), stamping `by` with the student.
 */
import { ensureRedis } from './redis';
import { livekitRoomNameForCode, sendRoomData } from './livekit';
import { nudgeRoomState } from './roomNudge';
import { WB_TOPIC, cleanItem, type Op, type Packet } from './whiteboard/model';
import { prisma } from './db';

const TTL_S = 6 * 60 * 60;
export const wbKey = (code: string) => `room:${code}:wb`;
/** Latest teacher snapshot (base64 packets, JSON list): shared by every web instance. */
export const wbSnapKey = (code: string) => `room:${code}:wbsnap`;
export const WB_SNAP_MAX_PACKETS = 64;
export const WB_SNAP_MAX_B64 = 96_000;
export const WB_SNAP_MAX_TOTAL = 2_000_000;

export async function storeSnapshot(code: string, packets: string[]) {
  await (await ensureRedis()).set(wbSnapKey(code), JSON.stringify(packets), 'EX', TTL_S);
}

export async function storedSnapshot(code: string): Promise<string[]> {
  try {
    const raw = await (await ensureRedis()).get(wbSnapKey(code));
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export async function clearStoredSnapshot(code: string) {
  await (await ensureRedis()).del(wbSnapKey(code));
}

export async function whiteboardOn(code: string): Promise<boolean> {
  try {
    return (await (await ensureRedis()).get(wbKey(code))) === '1';
  } catch {
    return false;
  }
}

export async function setWhiteboard(code: string, on: boolean) {
  const r = await ensureRedis();
  if (on) await r.set(wbKey(code), '1', 'EX', TTL_S);
  else {
    await r.del(wbKey(code));
    await sendWb(code, { v: 1, t: 'end' });
  }
  nudgeRoomState(code, 'all');
}

export async function sendWb(code: string, packet: Packet, destinationIdentities?: string[]) {
  const name = await livekitRoomNameForCode(code);
  if (name) await sendRoomData(name, packet, { topic: WB_TOPIC, destinationIdentities });
}

/** Ask the teacher's device for a snapshot for `to`. */
export async function requestSnapshot(code: string, to: string) {
  const room = await prisma.room.findUnique({ where: { code }, select: { id: true } });
  if (!room) return;
  const teacher = await prisma.participant.findFirst({
    where: { roomId: room.id, role: 'TEACHER' },
    orderBy: { createdAt: 'asc' },
    select: { livekitIdentity: true },
  });
  if (!teacher) return;
  await sendWb(code, { v: 1, t: 'req', to }, [teacher.livekitIdentity]);
}

/**
 * Pure: validate and stamp ops a permitted student sent. Only their own pen
 * strokes: add (stroke), pts and del. `del` / `pts` are checked by the
 * teacher device too (it owns the board), which drops ops on others' items.
 */
export function sanitizeStudentOps(raw: unknown, identity: string): Op[] {
  if (!Array.isArray(raw)) return [];
  const out: Op[] = [];
  for (const o of raw.slice(0, 20) as Record<string, unknown>[]) {
    const p = String(o?.p ?? '');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(p)) continue;
    if (o.k === 'add') {
      const item = cleanItem({ ...(o.item as object), by: identity });
      if (item && item.k === 'stroke' && item.tool === 'pen' && item.id.startsWith('s')) out.push({ k: 'add', p, item });
    } else if (o.k === 'pts' && typeof o.id === 'string' && o.id.startsWith('s') && Array.isArray(o.pts)) {
      out.push({ k: 'pts', p, id: o.id.slice(0, 40), pts: (o.pts as unknown[]).slice(0, 2000).map((n) => Math.round(Number(n)) || 0) });
    } else if (o.k === 'del' && Array.isArray(o.ids)) {
      const ids = (o.ids as unknown[]).map(String).filter((id) => id.startsWith('s')).slice(0, 200);
      if (ids.length) out.push({ k: 'del', p, ids });
    }
  }
  return out;
}


/** At most 10 snapshot requests per minute per requester. */
export async function allowReq(key: string): Promise<boolean> {
  try {
    const r = await ensureRedis();
    const n = await r.incr(key);
    if (n === 1) await r.expire(key, 60);
    return n <= 10;
  } catch {
    return true;
  }
}

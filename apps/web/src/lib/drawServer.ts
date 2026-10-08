/**
 * Server side of student drawing on the shared screen (see lib/drawLogic.ts
 * for the overview). Redis holds the requests, the single holder and the
 * strokes; packets to clients go out as server-originated LiveKit data.
 */
import { ensureRedis, keys } from './redis';
import { livekitRoomNameForCode, sendRoomData } from './livekit';
import { nudgeRoomState } from './roomNudge';
import {
  DRAW_ALLOW_MS,
  DRAW_TOPIC,
  MAX_STROKE_POINTS,
  MAX_STROKES,
  holderActive,
  type DrawColor,
  type DrawHolder,
  type DrawPacket,
  type Stroke,
} from './drawLogic';

const TTL_S = 6 * 60 * 60;

type R = Awaited<ReturnType<typeof ensureRedis>>;

async function send(code: string, packet: DrawPacket) {
  const name = await livekitRoomNameForCode(code);
  if (name) await sendRoomData(name, packet, { topic: DRAW_TOPIC });
}

function parseHolder(raw: string | null): DrawHolder | null {
  if (!raw) return null;
  try {
    const h = JSON.parse(raw) as DrawHolder;
    return h && typeof h.identity === 'string' && typeof h.until === 'number' ? h : null;
  } catch {
    return null;
  }
}

/**
 * The current holder, or null. An expired allow is removed here (the state
 * route calls this on every poll), and everyone is told.
 */
export async function currentHolder(code: string, redis?: R): Promise<DrawHolder | null> {
  const r = redis ?? (await ensureRedis());
  const h = parseHolder(await r.get(keys.drawHolder(code)));
  if (!h) return null;
  if (holderActive(h)) return h;
  await r.del(keys.drawHolder(code));
  nudgeRoomState(code, 'all');
  return null;
}

/** Request ids with request time, earliest first. */
export async function drawRequests(code: string, redis?: R): Promise<{ id: string; at: number }[]> {
  const r = redis ?? (await ensureRedis());
  const all = await r.hgetall(keys.drawRequests(code));
  return Object.entries(all)
    .map(([id, at]) => ({ id, at: Number(at) || 0 }))
    .sort((a, b) => a.at - b.at);
}

export async function setDrawRequest(code: string, participantId: string, on: boolean) {
  const r = await ensureRedis();
  if (on) {
    await r.multi().hsetnx(keys.drawRequests(code), participantId, String(Date.now())).expire(keys.drawRequests(code), TTL_S).exec();
  } else {
    await r.hdel(keys.drawRequests(code), participantId);
  }
  nudgeRoomState(code, 'all');
}

/** Allow ONE student (replaces any other holder; their strokes stay). */
export async function allowDraw(code: string, p: { id: string; livekitIdentity: string; displayName: string }, now = Date.now()) {
  const r = await ensureRedis();
  const holder: DrawHolder = { participantId: p.id, identity: p.livekitIdentity, name: p.displayName, until: now + DRAW_ALLOW_MS };
  await r
    .multi()
    .set(keys.drawHolder(code), JSON.stringify(holder), 'PX', DRAW_ALLOW_MS + 60_000)
    .hdel(keys.drawRequests(code), p.id)
    .exec();
  nudgeRoomState(code, 'all');
  return holder;
}

/** End the allow. `clear` also wipes every stroke (teacher Revoke, share stopped). */
export async function revokeDraw(code: string, opts: { clear: boolean; clearRequests?: boolean }) {
  const r = await ensureRedis();
  const m = r.multi().del(keys.drawHolder(code));
  if (opts.clearRequests) m.del(keys.drawRequests(code));
  await m.exec();
  if (opts.clear) await clearDrawing(code);
  nudgeRoomState(code, 'all');
}

export async function clearDrawing(code: string) {
  const r = await ensureRedis();
  await r.del(keys.drawStrokes(code), keys.drawOrder(code));
  await send(code, { v: 1, t: 'clear' });
}

/** Share stopped / class ended: nobody draws, nothing stays on screen. */
export async function endDrawingSession(code: string) {
  await revokeDraw(code, { clear: true, clearRequests: true });
}

export async function listStrokes(code: string, redis?: R): Promise<Stroke[]> {
  const r = redis ?? (await ensureRedis());
  const ids = await r.lrange(keys.drawOrder(code), 0, -1);
  if (!ids.length) return [];
  const raw = await r.hmget(keys.drawStrokes(code), ...ids);
  const out: Stroke[] = [];
  for (const s of raw) {
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as Stroke);
    } catch {
      /* skip */
    }
  }
  return out;
}

export class DrawError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

/** Append points to the holder's stroke (creating it), then relay. */
export async function appendPoints(
  code: string,
  holder: DrawHolder,
  input: { id: string; from: number; pts: number[]; color: DrawColor }
) {
  const r = await ensureRedis();
  const raw = await r.hget(keys.drawStrokes(code), input.id);
  let stroke: Stroke;
  let from: number;
  if (raw) {
    stroke = JSON.parse(raw) as Stroke;
    if (stroke.by !== holder.identity) throw new DrawError('Not your stroke', 403);
    from = Math.min(stroke.pts.length, Math.max(0, input.from));
    stroke.pts = [...stroke.pts.slice(0, from), ...input.pts].slice(0, MAX_STROKE_POINTS * 2);
  } else {
    if ((await r.llen(keys.drawOrder(code))) >= MAX_STROKES) throw new DrawError('The drawing is full. Ask your teacher to clear it.', 409);
    from = 0;
    stroke = { id: input.id, by: holder.identity, name: holder.name, color: input.color, pts: input.pts.slice(0, MAX_STROKE_POINTS * 2) };
  }
  const m = r.multi().hset(keys.drawStrokes(code), stroke.id, JSON.stringify(stroke));
  if (!raw) m.rpush(keys.drawOrder(code), stroke.id);
  await m.expire(keys.drawStrokes(code), TTL_S).expire(keys.drawOrder(code), TTL_S).exec();
  await send(code, { v: 1, t: 'pts', id: stroke.id, by: stroke.by, name: stroke.name, c: stroke.color, from, pts: input.pts });
}

/** Eraser / undo: a student removes one of their OWN strokes. */
export async function deleteOwnStroke(code: string, identity: string, id: string) {
  const r = await ensureRedis();
  const raw = await r.hget(keys.drawStrokes(code), id);
  if (!raw) return;
  const s = JSON.parse(raw) as Stroke;
  if (s.by !== identity) throw new DrawError('You can only erase your own drawing', 403);
  await r.multi().hdel(keys.drawStrokes(code), id).lrem(keys.drawOrder(code), 0, id).exec();
  await send(code, { v: 1, t: 'del', id });
}

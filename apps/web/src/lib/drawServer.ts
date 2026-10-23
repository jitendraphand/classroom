/**
 * Server side of student drawing on the shared screen (see lib/drawLogic.ts
 * for the overview). Redis holds the requests, the holders (several at once) and the
 * strokes; packets to clients go out as server-originated LiveKit data.
 */
import { ensureRedis, keys } from './redis';
import { livekitRoomNameForCode, sendRoomData } from './livekit';
import { nudgeRoomState, pushSignalForCode } from './roomNudge';
import {
  DRAW_ALLOW_MS,
  DRAW_TOPIC,
  MAX_STROKE_POINTS,
  MAX_DRAWERS,
  MAX_STROKES,
  parseHolders,
  type DrawColor,
  type DrawHolder,
  type DrawPacket,
  type Stroke,
} from './drawLogic';

const TTL_S = 6 * 60 * 60;

type R = Awaited<ReturnType<typeof ensureRedis>>;

const WB_TOPIC_NAME = 'wb';
async function send(code: string, packet: DrawPacket, topic: string = DRAW_TOPIC) {
  const name = await livekitRoomNameForCode(code);
  if (name) await sendRoomData(name, packet, { topic });
}

/**
 * Students allowed to draw now (several at once, up to MAX_DRAWERS), earliest
 * allow first. Expired allows are removed here (the state route calls this on
 * every poll), and everyone is told.
 */
export async function currentHolders(code: string, redis?: R): Promise<DrawHolder[]> {
  const r = redis ?? (await ensureRedis());
  const { active, expired } = parseHolders(await r.hgetall(keys.drawHolders(code)));
  if (expired.length) {
    await r.hdel(keys.drawHolders(code), ...expired);
    nudgeRoomState(code, 'all');
  }
  return active;
}

/** The first holder (back-compat for older clients), or null. */
export async function currentHolder(code: string, redis?: R): Promise<DrawHolder | null> {
  return (await currentHolders(code, redis))[0] ?? null;
}

export async function holderFor(code: string, participantId: string, redis?: R): Promise<DrawHolder | null> {
  return (await currentHolders(code, redis)).find((h) => h.participantId === participantId) ?? null;
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
  pushSignalForCode(code, { v: 1, type: 'draw-req', on, participantId });
}

/**
 * Allow a student to draw. Other students who are drawing keep drawing (up to
 * MAX_DRAWERS at once); allowing the same student again extends the time.
 */
export async function allowDraw(code: string, p: { id: string; livekitIdentity: string; displayName: string }, now = Date.now()) {
  const r = await ensureRedis();
  const others = (await currentHolders(code, r)).filter((h) => h.participantId !== p.id);
  if (others.length >= MAX_DRAWERS) {
    throw new DrawError(`Up to ${MAX_DRAWERS} students can draw at once. Revoke someone first.`, 409);
  }
  const holder: DrawHolder = { participantId: p.id, identity: p.livekitIdentity, name: p.displayName, until: now + DRAW_ALLOW_MS };
  await r
    .multi()
    .hset(keys.drawHolders(code), p.id, JSON.stringify(holder))
    .expire(keys.drawHolders(code), TTL_S)
    .hdel(keys.drawRequests(code), p.id)
    .exec();
  // One small SFU packet for everyone instead of a /state refetch by every
  // student (2,000 simultaneous refetches made "Allow draw" time out). The
  // teacher and the student still get a refetch for the rest of the state.
  pushSignalForCode(code, { v: 1, type: 'draw-allow', on: true, ...holder });
  nudgeRoomState(code, { participantIds: [p.id] });
  return holder;
}

/**
 * End allows. With `participantId` only that student stops (and with `clear`
 * only their strokes go); without it everyone stops (and `clear` wipes every
 * stroke: teacher Revoke all, share stopped).
 */
export async function revokeDraw(code: string, opts: { clear: boolean; clearRequests?: boolean; participantId?: string }) {
  const r = await ensureRedis();
  if (opts.participantId) {
    const h = await holderFor(code, opts.participantId, r);
    await r.hdel(keys.drawHolders(code), opts.participantId);
    if (h) pushSignalForCode(code, { v: 1, type: 'draw-allow', on: false, ...h });
    if (opts.clear && h) {
      await deleteStrokesBy(code, h.identity);
      // Whiteboard: the student's strokes go too (every device incl. the teacher's applies it).
      await send(code, { v: 1, t: 'ops', ops: [{ k: 'delBy', by: h.identity }] } as unknown as DrawPacket, WB_TOPIC_NAME);
    }
  } else {
    const m = r.multi().del(keys.drawHolders(code), keys.drawHolder(code));
    if (opts.clearRequests) m.del(keys.drawRequests(code));
    await m.exec();
    if (opts.clear) await clearDrawing(code);
    nudgeRoomState(code, 'all');
    return;
  }
  nudgeRoomState(code, { participantIds: [opts.participantId] });
}

/** Remove every stroke of one student (their allow was revoked). */
export async function deleteStrokesBy(code: string, identity: string) {
  const ids = (await listStrokes(code)).filter((s) => s.by === identity).map((s) => s.id);
  if (ids.length) await deleteStrokes(code, ids);
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
  input: { id: string; from: number; pts: number[]; color: DrawColor },
  opts?: { relay?: boolean }
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
  if (opts?.relay !== false) {
    await send(code, { v: 1, t: 'pts', id: stroke.id, by: stroke.by, name: stroke.name, c: stroke.color, from, pts: input.pts });
  }
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

/** Teacher eraser: remove any stroke (relayed as `del` to every viewer). */
/** Batch teacher erase: one Redis round trip; one `del` packet per removed stroke (what every client already understands). */
export async function deleteStrokes(code: string, ids: readonly string[]): Promise<number> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return 0;
  const r = await ensureRedis();
  const m = r.multi();
  for (const id of uniq) m.hdel(keys.drawStrokes(code), id).lrem(keys.drawOrder(code), 0, id);
  const res = (await m.exec()) ?? [];
  let removed = 0;
  for (let i = 0; i < uniq.length; i++) {
    if (Number(res[i * 2]?.[1] ?? 0) > 0) {
      removed++;
      await send(code, { v: 1, t: 'del', id: uniq[i]! });
    }
  }
  return removed;
}

export async function deleteStroke(code: string, id: string) {
  const r = await ensureRedis();
  const removed = await r.hdel(keys.drawStrokes(code), id);
  await r.lrem(keys.drawOrder(code), 0, id);
  if (removed) await send(code, { v: 1, t: 'del', id });
}

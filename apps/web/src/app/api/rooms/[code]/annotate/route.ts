import { z } from 'zod';
import { prisma } from '@/lib/db';
import { resolveRoomAccess } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureRedis, keys } from '@/lib/redis';

export const dynamic = 'force-dynamic';

/**
 * Screen-share annotation snapshots.
 *
 * Live-streamed over the LiveKit data channel (topic `annotate`); this route is
 * only the durable copy so a student who joins mid-class, or reconnects, can
 * catch up. Same size-cap discipline as the whiteboard route: a bounded key
 * here, so a runaway drawing client cannot exhaust Redis.
 */
const MAX_SNAPSHOT_BYTES = 256_000;
/** Ceiling on the request body, before JSON parsing. */
const MAX_BODY_BYTES = 512_000;
/** Matches the stage key TTL — annotations die with the share session. */
const TTL_SECONDS = 60 * 60 * 6;

const point = z.tuple([z.number(), z.number()]);

const strokeSchema = z.object({
  id: z.string().min(1).max(64),
  tool: z.enum(['pen', 'highlighter']),
  color: z.string().min(1).max(32),
  width: z.number().min(0.5).max(64),
  points: z.array(point).max(20_000),
});

const putSchema = z.object({ strokes: z.array(strokeSchema).max(2_000) });

type AccessResult =
  | { ok: true; room: { id: string; code: string; status: string }; isTeacher: boolean }
  | { ok: false; reason: 'ended' | 'unauthorized' | 'not_found' };

/** Teacher owns the annotation layer; admitted students may only read it. */
async function canAccess(req: Request, code: string): Promise<AccessResult> {
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room) return { ok: false, reason: 'not_found' };
  if (room.status === 'ENDED') return { ok: false, reason: 'ended' };

  const url = new URL(req.url);
  const forceStudent =
    url.searchParams.get('as') === 'student' ||
    req.headers.get('x-classroom-as') === 'student';
  const access = await resolveRoomAccess(room, { forceStudent });
  if (access.isTeacher) return { ok: true, room, isTeacher: true };
  if (
    access.mode === 'student' &&
    access.student &&
    access.student.roomId === room.id &&
    access.student.status === 'ADMITTED'
  ) {
    return { ok: true, room, isTeacher: false };
  }
  return { ok: false, reason: 'unauthorized' };
}

function deny(result: AccessResult) {
  if (result.ok) return null;
  if (result.reason === 'ended') return jsonError('Class ended', 410, { ended: true });
  if (result.reason === 'not_found') return jsonError('Room not found', 404);
  return jsonError('Unauthorized', 401);
}

export async function GET(req: Request, { params }: { params: { code: string } }) {
  const code = params.code.toUpperCase();
  const result = await canAccess(req, code);
  const err = deny(result);
  if (err) return err;

  const redis = await ensureRedis();
  const raw = await redis.get(keys.annotate(code));

  let strokes: unknown = [];
  if (raw) {
    try {
      strokes = JSON.parse(raw) as unknown;
    } catch (e) {
      // A corrupt value must degrade to an empty layer, not 500 the join path.
      console.warn('annotation snapshot unreadable, serving empty', code, e);
      strokes = [];
    }
  }
  return jsonOk({ strokes });
}

export async function PUT(req: Request, { params }: { params: { code: string } }) {
  const code = params.code.toUpperCase();
  const result = await canAccess(req, code);
  const err = deny(result);
  if (err) return err;
  if (!result.ok || !result.isTeacher) return jsonError('Teacher only', 403);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return jsonError('Snapshot too large', 413);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw) as unknown;
  } catch {
    return jsonError('Invalid payload', 400);
  }

  const parsed = putSchema.safeParse(parsedJson);
  if (!parsed.success) return jsonError('Invalid payload', 400);

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify({ strokes: parsed.data.strokes });
  } catch {
    return jsonError('Not serialisable', 400);
  }
  if (typeof serialized !== 'string') return jsonError('Not serialisable', 400);
  if (serialized.length > MAX_SNAPSHOT_BYTES) {
    return jsonError('Annotation snapshot is too large', 413, {
      maxBytes: MAX_SNAPSHOT_BYTES,
    });
  }

  try {
    const redis = await ensureRedis();
    if (!parsed.data.strokes.length) {
      await redis.del(keys.annotate(code));
    } else {
      await redis.set(keys.annotate(code), serialized, 'EX', TTL_SECONDS);
    }
    return jsonOk({ ok: true, count: parsed.data.strokes.length });
  } catch (e) {
    console.error(e);
    return jsonError('Save failed', 500);
  }
}

import { z } from 'zod';
import { prisma } from '@/lib/db';
import { resolveRoomAccess } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureRedis, keys } from '@/lib/redis';

export const dynamic = 'force-dynamic';

/**
 * A tldraw document snapshot is the whole board. Anything beyond this is either
 * corrupt or hostile: an unbounded write here is a direct way to exhaust the
 * Redis memory ceiling (and, with AOF enabled, the disk).
 */
const MAX_SNAPSHOT_BYTES = 512_000;
/** Ceiling on the request body, before JSON parsing. */
const MAX_BODY_BYTES = 1_000_000;

const putSchema = z.object({ snapshot: z.unknown() });

/** Require the key on the RAW body: zod's output always carries the key. */
function hasSnapshotKey(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'snapshot' in value;
}

type AccessResult =
  | { ok: true; room: { id: string; code: string; status: string }; isTeacher: boolean }
  | { ok: false; reason: 'ended' | 'unauthorized' | 'not_found' };

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

/** Reject oversized bodies before they are buffered or parsed. */
async function readBoundedJson(req: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

export async function GET(req: Request, { params }: { params: { code: string } }) {
  const code = params.code.toUpperCase();
  const result = await canAccess(req, code);
  const err = deny(result);
  if (err) return err;
  const redis = await ensureRedis();
  const raw = await redis.get(keys.whiteboard(code));
  const wbWrite = (await redis.get(keys.wbWrite(code))) === '1';
  const canWrite = result.ok && (result.isTeacher || wbWrite);

  // A corrupt or non-JSON value must not turn every board poll into a 500.
  let snapshot: unknown = null;
  if (raw) {
    try {
      snapshot = JSON.parse(raw) as unknown;
    } catch (e) {
      console.warn('whiteboard snapshot unreadable, serving empty board', code, e);
      snapshot = null;
    }
  }

  return jsonOk({ snapshot, canWrite });
}

export async function PUT(req: Request, { params }: { params: { code: string } }) {
  const code = params.code.toUpperCase();
  const result = await canAccess(req, code);
  const err = deny(result);
  if (err) return err;

  if (result.ok && !result.isTeacher) {
    const redis = await ensureRedis();
    const wbWrite = (await redis.get(keys.wbWrite(code))) === '1';
    if (!wbWrite) {
      return jsonError('Whiteboard is view-only', 403);
    }
  }

  const read = await readBoundedJson(req);
  if (!read.ok) return jsonError('Invalid whiteboard snapshot payload', 413);

  const parsed = putSchema.safeParse(read.value);
  if (!parsed.success || !hasSnapshotKey(read.value)) {
    return jsonError('Invalid whiteboard snapshot payload', 400);
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(parsed.data.snapshot);
  } catch {
    return jsonError('Snapshot is not serialisable', 400);
  }
  // `undefined` here means the value is not JSON-representable (undefined,
  // a function, a symbol, BigInt) rather than too large.
  if (typeof serialized !== 'string') {
    return jsonError('Snapshot is not serialisable', 400);
  }
  if (serialized.length > MAX_SNAPSHOT_BYTES) {
    return jsonError('Whiteboard snapshot is too large', 413, {
      maxBytes: MAX_SNAPSHOT_BYTES,
    });
  }

  try {
    const redis = await ensureRedis();
    await redis.set(keys.whiteboard(code), serialized, 'EX', 60 * 60 * 6);
    return jsonOk({ ok: true });
  } catch (e) {
    console.error(e);
    return jsonError('Save failed', 500);
  }
}

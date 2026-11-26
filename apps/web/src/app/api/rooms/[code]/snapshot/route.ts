import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getTeacherSession, resolveRoomAccess } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { ensureRedis, keys } from '@/lib/redis';
import { livekitRoomName, sendRoomData } from '@/lib/livekit';
import { overRateLimit } from '@/lib/rateLimit';
import {
  SERVER_MIN_GAP_S,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_TOPIC,
  SNAPSHOT_TTL_S,
  snapshotBytesValid,
  type SnapshotPacket,
} from '@/lib/slideSnapshot';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Slide snapshot (lib/slideSnapshot) for students in "Audio only" mode.
 * - POST (teacher): `{ image: <base64>, type: 'image/webp' | 'image/jpeg' }`,
 *   the latest still of the share; replaces the previous one and tells the
 *   class a new one exists (tiny data packet; only audio-only students fetch).
 * - DELETE (teacher): the share stopped; the snapshot is dropped.
 * - GET (teacher or admitted student): the image, or 204 when there is none.
 *   Send `If-None-Match` with the last ETag to get 304 when unchanged.
 */
const postSchema = z.object({
  image: z.string().min(16).max(Math.ceil((SNAPSHOT_MAX_BYTES * 4) / 3) + 8),
  type: z.enum(['image/webp', 'image/jpeg']),
});

type Meta = { ver: number; type: 'image/webp' | 'image/jpeg' };

async function teacherRoom(code: string) {
  const teacher = await getTeacherSession();
  if (!teacher) return { error: jsonError('Unauthorized', 401) };
  const room = await prisma.room.findUnique({ where: { code }, select: { code: true, sessionId: true, teacherId: true, status: true } });
  if (!room || room.teacherId !== teacher.id) return { error: jsonError('Room not found', 404) };
  if (room.status === 'ENDED') return { error: jsonError('Class ended', 410, { ended: true }) };
  return { room };
}

function announce(room: { code: string; sessionId: string }, ver: number) {
  const packet: SnapshotPacket = { v: 1, ver };
  void sendRoomData(livekitRoomName(room.code, room.sessionId), packet, { topic: SNAPSHOT_TOPIC }).catch(() => undefined);
}

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  const t = await teacherRoom(code);
  if ('error' in t) return t.error;
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError('Invalid snapshot');
  const bytes = Buffer.from(parsed.data.image, 'base64');
  if (!snapshotBytesValid(bytes, parsed.data.type)) return jsonError('Invalid snapshot image', 400);
  if (await overRateLimit(`ratelimit:snapshot:${code}`, 1, SERVER_MIN_GAP_S)) return jsonError('Too many snapshots', 429);
  const meta: Meta = { ver: Date.now(), type: parsed.data.type };
  const redis = await ensureRedis();
  await redis
    .multi()
    .set(keys.snapshot(code), bytes, 'EX', SNAPSHOT_TTL_S)
    .set(keys.snapshotMeta(code), JSON.stringify(meta), 'EX', SNAPSHOT_TTL_S)
    .exec();
  announce(t.room, meta.ver);
  return jsonOk({ ok: true, ver: meta.ver, bytes: bytes.length });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  const t = await teacherRoom(code);
  if ('error' in t) return t.error;
  const redis = await ensureRedis();
  const had = await redis.del(keys.snapshot(code), keys.snapshotMeta(code));
  if (had) announce(t.room, 0);
  return jsonOk({ ok: true });
}

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room) return jsonError('Room not found', 404);
  if (room.status === 'ENDED') return new Response(null, { status: 204 });
  const url = new URL(req.url);
  const forceStudent = url.searchParams.get('as') === 'student' || req.headers.get('x-classroom-as') === 'student';
  const access = await resolveRoomAccess(room, { forceStudent });
  const admitted = access.mode === 'student' && access.student?.roomId === room.id && access.student.status === 'ADMITTED';
  if (!access.isTeacher && !admitted) return jsonError('Unauthorized', 401);

  const redis = await ensureRedis();
  const rawMeta = await redis.get(keys.snapshotMeta(code));
  let meta: Meta | null = null;
  try {
    meta = rawMeta ? (JSON.parse(rawMeta) as Meta) : null;
  } catch {
    meta = null;
  }
  if (!meta) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  const etag = `"${meta.ver}"`;
  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'no-store' } });
  }
  const bytes = await redis.getBuffer(keys.snapshot(code));
  if (!bytes) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': meta.type,
      'Content-Length': String(bytes.length),
      ETag: etag,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

import { prisma } from '@/lib/db';
import { getTeacherSession } from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { overRateLimit } from '@/lib/rateLimit';
import { ASSET_MAX_BYTES, assetBytesValid, readBodyCapped, storeAsset } from '@/lib/whiteboardAssets';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Teacher: upload one whiteboard image (an inserted picture or one PDF page).
 * Body: the raw image bytes; Content-Type image/jpeg, image/png or image/webp.
 * Answers `{ id }`; the board item then uses `src: "asset:<id>"`.
 */
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toUpperCase();
  const teacher = await getTeacherSession();
  if (!teacher) return jsonError('Unauthorized', 401);
  const room = await prisma.room.findUnique({ where: { code }, select: { teacherId: true, status: true } });
  if (!room || room.teacherId !== teacher.id) return jsonError('Room not found', 404);
  if (room.status === 'ENDED') return jsonError('Class ended', 410, { ended: true });
  // A 40-page PDF arrives as 40 uploads in a few seconds.
  if (await overRateLimit(`ratelimit:wbasset:${code}`, 120, 60)) return jsonError('Too many uploads', 429);
  const type = (req.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase();
  const bytes = await readBodyCapped(req, ASSET_MAX_BYTES);
  if (!bytes) return jsonError('Image is larger than 2 MB', 413);
  if (!assetBytesValid(bytes, type)) return jsonError('Not a JPEG, PNG or WebP image', 400);
  const id = await storeAsset(code, bytes, type);
  if (!id) return jsonError('This class has too many whiteboard images', 413);
  return jsonOk({ id });
}

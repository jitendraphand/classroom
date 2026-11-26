import { prisma } from '@/lib/db';
import { resolveRoomAccess } from '@/lib/auth';
import { getAdminSession } from '@/lib/auth';
import { adminApiDenied } from '@/lib/adminGuard';
import { jsonError } from '@/lib/response';
import { ASSET_ID_RE, loadAsset } from '@/lib/whiteboardAssets';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * One whiteboard image, for the class teacher, an admitted student, or an
 * admin allowed to monitor live classes. Content-addressed, so the browser
 * may keep it (private cache only).
 */
export async function GET(req: Request, { params }: { params: Promise<{ code: string; id: string }> }) {
  const p = await params;
  const code = p.code.toUpperCase();
  const id = String(p.id || '').toLowerCase();
  if (!ASSET_ID_RE.test(id)) return jsonError('Not found', 404);
  const room = await prisma.room.findUnique({ where: { code } });
  if (!room || room.status === 'ENDED') return jsonError('Not found', 404);
  const url = new URL(req.url);
  const forceStudent = url.searchParams.get('as') === 'student' || req.headers.get('x-classroom-as') === 'student';
  const access = await resolveRoomAccess(room, { forceStudent });
  const admitted = access.mode === 'student' && access.student?.roomId === room.id && access.student.status === 'ADMITTED';
  if (!access.isTeacher && !admitted && adminApiDenied(await getAdminSession(), 'monitorLive')) {
    return jsonError('Unauthorized', 401);
  }
  const asset = await loadAsset(code, id);
  if (!asset) return jsonError('Not found', 404);
  return new Response(new Uint8Array(asset.bytes), {
    status: 200,
    headers: {
      'Content-Type': asset.type,
      'Content-Length': String(asset.bytes.length),
      'Cache-Control': 'private, max-age=43200, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

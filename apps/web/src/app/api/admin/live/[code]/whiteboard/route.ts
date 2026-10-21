import { requireAdminApi } from '@/lib/adminGuard';
import { jsonError, jsonOk } from '@/lib/response';
import { allowReq, requestSnapshot, whiteboardOn } from '@/lib/whiteboardServer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Admin preview / observer: is the whiteboard open, and ask the teacher's
 * device to send the board to this observer identity (which must be one of
 * this admin's own observer identities).
 */
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const g = await requireAdminApi('monitorLive');
  if (g.res) return g.res;
  const code = String((await params).code || '').toUpperCase().slice(0, 32);
  const body = (await req.json().catch(() => null)) as { identity?: unknown } | null;
  const identity = String(body?.identity ?? '');
  const on = await whiteboardOn(code);
  if (!identity) return jsonOk({ on });
  if (!identity.startsWith(`adminpreview_${g.admin.id}_`) && !identity.startsWith(`adminobserver_${g.admin.id}_`)) {
    return jsonError('Not your observer identity', 403);
  }
  if (on && (await allowReq(`wbreq:${identity}`))) await requestSnapshot(code, identity);
  return jsonOk({ on });
}

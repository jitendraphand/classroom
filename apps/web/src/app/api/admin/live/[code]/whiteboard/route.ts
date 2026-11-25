import { requireAdminApi } from '@/lib/adminGuard';
import { jsonError, jsonOk } from '@/lib/response';
import { allowReq, requestSnapshot, storedSnapshot, whiteboardOn } from '@/lib/whiteboardServer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Admin observer: check if the whiteboard is open, request a live snapshot
 * from the teacher's device, or fetch the server-stored snapshot fallback.
 */
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const g = await requireAdminApi('monitorLive');
  if (g.res) return g.res;
  const code = String((await params).code || '').toUpperCase().slice(0, 32);
  const body = (await req.json().catch(() => null)) as { identity?: unknown; stored?: unknown } | null;
  const on = await whiteboardOn(code);
  if (body?.stored) {
    return jsonOk({ on, packets: on ? await storedSnapshot(code) : [] });
  }
  const identity = String(body?.identity ?? '');
  if (!identity) return jsonOk({ on });
  if (!identity.startsWith(`adminpreview_${g.admin.id}_`) && !identity.startsWith(`adminobserver_${g.admin.id}_`)) {
    return jsonError('Not your observer identity', 403);
  }
  if (on && (await allowReq(`wbreq:${identity}`))) await requestSnapshot(code, identity);
  return jsonOk({ on });
}

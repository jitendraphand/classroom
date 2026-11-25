import { requireAdminApi } from '@/lib/adminGuard';
import { handleObserverHeartbeat } from '@/lib/adminLiveApi';
import { refreshObserver, unregisterObserver } from '@/lib/adminObservers';
import { getLiveClass } from '@/lib/liveClasses';
import { syncObserverCameras } from '@/lib/observerSync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Admin only (`monitorLive` privilege): keep an active observer lease alive
 * while /admin/live/[code] is open, or release it immediately on leave /
 * switch / hide so students stop publishing extra camera streams.
 */
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const body = await req.json().catch(() => null);
  return handleObserverHeartbeat((await params).code, body, {
    guard: () => requireAdminApi('monitorLive'),
    exists: async (code) => !!(await getLiveClass(code)),
    refresh: async (code, identity) => {
      const res = await refreshObserver(code, identity);
      if (res.transitionedToActive) await syncObserverCameras(code, true);
      return res;
    },
    unregister: async (code, identity) => {
      const res = await unregisterObserver(code, identity);
      if (res.transitionedToInactive) await syncObserverCameras(code, false);
      return res;
    },
  });
}

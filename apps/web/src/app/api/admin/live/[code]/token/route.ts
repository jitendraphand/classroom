import { requireAdminApi } from '@/lib/adminGuard';
import { handleObserverToken } from '@/lib/adminLiveApi';
import { getLiveClass } from '@/lib/liveClasses';
import { createObserverToken, getPublicLiveKitUrl } from '@/lib/livekit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Admin only: a hidden, publish-nothing LiveKit token for an ongoing class.
 * Body `{ mode: "preview" }` (2 min tile token) or `{ mode: "observe" }`.
 * POST, so the middleware Origin/content-type CSRF guard applies.
 */
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const body = await req.json().catch(() => null);
  return handleObserverToken((await params).code, body, {
    guard: requireAdminApi,
    get: getLiveClass,
    mint: createObserverToken,
    serverUrl: () => getPublicLiveKitUrl(req),
  });
}

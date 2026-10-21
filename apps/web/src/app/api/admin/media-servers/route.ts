import { z } from 'zod';
import { requireAdminApi } from '@/lib/adminGuard';
import { jsonError, jsonOk } from '@/lib/response';
import { mediaServerStatus, setDrainingServers } from '@/lib/mediaServers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Admin: media (LiveKit) nodes with their student load. */
export async function GET() {
  const g = await requireAdminApi('SYSTEM');
  if (g.res) return g.res;
  return jsonOk({ servers: await mediaServerStatus() });
}

/** Admin: drain nodes (no new classes are assigned to them). Body `{ draining: string[] }`. */
export async function POST(req: Request) {
  const g = await requireAdminApi('SYSTEM');
  if (g.res) return g.res;
  const parsed = z.object({ draining: z.array(z.string().max(64)).max(50) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError('draining must be a list of server ids');
  await setDrainingServers(parsed.data.draining);
  return jsonOk({ servers: await mediaServerStatus() });
}

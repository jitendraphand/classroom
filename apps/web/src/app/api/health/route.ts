import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { ensureRedis } from '@/lib/redis';
import { PEER_HEADER, ipMatches, trustedProxies } from '@/lib/clientIp';

export const dynamic = 'force-dynamic';

/**
 * Liveness + dependencies for Docker / Caddy health checks. Public callers get
 * the status only; details (worker, pool) are for loopback (the host's own
 * checks and the operator) and never include configuration secrets.
 */
export async function GET(req: Request) {
  const checks: Record<string, string> = { web: 'ok' };
  let ok = true;

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.postgres = 'ok';
  } catch {
    checks.postgres = 'error';
    ok = false;
  }

  try {
    const redis = await ensureRedis();
    checks.redis = (await redis.ping()) === 'PONG' ? 'ok' : 'error';
    if (checks.redis !== 'ok') ok = false;
  } catch {
    checks.redis = 'error';
    ok = false;
  }

  // Loopback without a proxy hop: Docker's / Caddy's own checks, or the operator on the host.
  const peer = req.headers.get(PEER_HEADER) || '';
  const local = !peer || (trustedProxies({}).some((r) => ipMatches(peer, r)) && !req.headers.get('x-forwarded-for'));
  const status = ok ? 'healthy' : 'degraded';
  const body = local
    ? {
        status,
        checks,
        pid: process.pid,
        webWorkers: process.env.WEB_WORKERS || 'auto',
        dbPoolPerWorker: process.env.DB_POOL_PER_WORKER || 'auto',
        livekit: process.env.LIVEKIT_API_KEY ? 'configured' : 'missing',
        timestamp: new Date().toISOString(),
      }
    : { status };
  return NextResponse.json(body, { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}

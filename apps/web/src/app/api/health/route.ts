import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { ensureRedis } from '@/lib/redis';
import { HARD_MAX_VISIBLE_STUDENT_VIDEOS, sampleConfig } from '@/lib/sample';

export const dynamic = 'force-dynamic';

export async function GET() {
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
    const pong = await redis.ping();
    checks.redis = pong === 'PONG' ? 'ok' : 'error';
    if (checks.redis !== 'ok') ok = false;
  } catch {
    checks.redis = 'error';
    ok = false;
  }

  checks.livekit = process.env.LIVEKIT_API_KEY ? 'configured' : 'missing';

  return NextResponse.json(
    {
      status: ok ? 'healthy' : 'degraded',
      checks,
      maxVisibleStudentVideos: sampleConfig().maxVisible,
      hardMaxVisibleStudentVideos: HARD_MAX_VISIBLE_STUDENT_VIDEOS,
      speakerPinUntilMute: true,
      sampleRotationSeconds: sampleConfig().rotationSeconds,
      timestamp: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 }
  );
}

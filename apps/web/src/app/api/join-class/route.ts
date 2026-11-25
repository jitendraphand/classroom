// TEMPORARY "Join the class" form (see lib/joinClassForm.ts). Delete with the feature.
import { prisma } from '@/lib/db';
import { loadMaster } from '@/lib/gradeMaster';
import { loadCampuses } from '@/lib/campusMaster';
import { handleJoinForm } from '@/lib/joinClassForm';
import { ensureJoinAudience } from '@/lib/joinClassSeed';
import { clientIp } from '@/lib/rateLimit';
import { ensureRedis } from '@/lib/redis';
import { joinRateLimited, joinRateLimitFromEnv, schoolJoinModeFromEnv } from '@/lib/schoolJoin';
import { finishStudentJoin } from '@/lib/studentJoinFinish';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST { firstName, lastName, grade, campus, foundation } → session set, `{ ok, redirect: '/student' }`. */
export async function POST(req: Request) {
  try {
    await ensureJoinAudience();
  } catch (e) {
    console.error('join-class: could not seed options', e instanceof Error ? e.message : e);
  }
  const body = await req.json().catch(() => null);
  return handleJoinForm(body, {
    mode: schoolJoinModeFromEnv(),
    grades: loadMaster,
    campuses: loadCampuses,
    onFile: (cls) =>
      prisma.student.findMany({
        where: { campus: cls.campus, grade: cls.grade, division: cls.division, deletedAt: null },
        select: { externalId: true, name: true },
      }),
    // Same per-IP window as the school-app link (JOIN_RATE_LIMIT_PER_MINUTE, off by default).
    limited: async () => {
      try {
        return await joinRateLimited(clientIp(req), await ensureRedis(), joinRateLimitFromEnv());
      } catch {
        return false;
      }
    },
    finish: finishStudentJoin,
  });
}

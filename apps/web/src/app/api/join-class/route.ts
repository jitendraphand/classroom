// TEMPORARY "Join the class" form (see lib/joinClassForm.ts). Delete with the feature.
import { prisma } from '@/lib/db';
import { loadMaster } from '@/lib/gradeMaster';
import { loadCampuses } from '@/lib/campusMaster';
import { handleJoinForm } from '@/lib/joinClassForm';
import { ensureJoinAudienceCached } from '@/lib/joinClassSeed';
import { clientIp, overRateLimit } from '@/lib/rateLimit';
import { ensureRedis } from '@/lib/redis';
import {
  joinRateLimited,
  joinRateLimitFromEnv,
  nameJoinAllowedFromEnv,
  newNameJoinKey,
  newNameJoinsPerClassFromEnv,
  schoolJoinModeFromEnv,
} from '@/lib/schoolJoin';
import { JoinTokenError, type JoinClaims } from '@/lib/schoolJwt';
import { jsonError } from '@/lib/response';
import { finishStudentJoin } from '@/lib/studentJoinFinish';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST { firstName, lastName, grade, campus, foundation } → session set, `{ ok, redirect: '/student' }`. */
/**
 * A name nobody has used in this class yet creates a `WEB-…` student: cap how
 * many a class gains per day (SEC-03). Known names (returning students,
 * imported roster) are never counted.
 */
async function finishWithNewNameCap(claims: JoinClaims, signed: boolean): Promise<void> {
  const cap = newNameJoinsPerClassFromEnv();
  if (cap > 0 && claims.studentId.startsWith('WEB-')) {
    const known = await prisma.student.findUnique({ where: { externalId: claims.studentId }, select: { id: true } });
    if (!known && (await overRateLimit(newNameJoinKey(claims), cap, 24 * 60 * 60))) {
      throw new JoinTokenError('rate_limited', 'new name');
    }
  }
  await finishStudentJoin(claims, signed);
}

export async function POST(req: Request) {
  if (!nameJoinAllowedFromEnv()) return jsonError('Join from your school app.', 404);
  try {
    await ensureJoinAudienceCached();
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
    finish: finishWithNewNameCap,
  });
}

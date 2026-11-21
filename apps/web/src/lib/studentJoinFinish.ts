/**
 * Last step of every student join (school-app link, and the temporary
 * "Join the class" form): per-SID throttle, campus, registry check, student
 * upsert and the student session. Throws JoinTokenError for anything the
 * student should be told about. The caller then sends them to /student, which
 * does routing, the no-class check, the waiting room and admission.
 */
import { clearStudentCookie, setActAsStudent, setPupilCookie } from './auth';
import { resolveJoinCampus } from './campusLogic';
import { loadCampuses } from './campusMaster';
import { ensureRedis } from './redis';
import { joinSidRateLimited, joinSidRateLimitFromEnv } from './schoolJoin';
import { JoinTokenError, type JoinClaims } from './schoolJwt';
import { assertKnownStudent, unsignedUpdatesFromEnv, upsertStudentFromClaims } from './studentService';

export async function finishStudentJoin(claims: JoinClaims, signed: boolean): Promise<void> {
  try {
    if (await joinSidRateLimited(claims.studentId, await ensureRedis(), joinSidRateLimitFromEnv())) {
      throw new JoinTokenError('rate_limited', 'sid');
    }
  } catch (e) {
    if (e instanceof JoinTokenError) throw e;
    /* Redis down: fail open */
  }
  // No campus given: the school's only campus (several → refused).
  const campus = resolveJoinCampus(claims.campus, await loadCampuses());
  if (!campus) throw new JoinTokenError('campus_required', 'campus');
  await assertKnownStudent(claims.studentId);
  const student = await upsertStudentFromClaims({ ...claims, campus }, undefined, {
    signed,
    allowUnsignedUpdates: unsignedUpdatesFromEnv(),
  });
  // Shared devices: drop any previous student's class seat on this browser.
  await clearStudentCookie();
  await setPupilCookie(student);
  await setActAsStudent();
}

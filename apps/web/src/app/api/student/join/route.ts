import { NextResponse } from 'next/server';
import { clearStudentCookie, getPupil, setActAsStudent, setPupilCookie } from '@/lib/auth';
import { clientIp } from '@/lib/rateLimit';
import { ensureRedis } from '@/lib/redis';
import {
  ERROR_FIELDS,
  isJoinNavigation,
  joinRateLimited,
  joinRateLimitFromEnv,
  joinSidRateLimited,
  joinSidRateLimitFromEnv,
  resolveSchoolJoin,
  schoolJoinModeFromEnv,
} from '@/lib/schoolJoin';
import { JoinTokenError, schoolJwtConfigFromEnv } from '@/lib/schoolJwt';
import { assertKnownStudent, unsignedUpdatesFromEnv, upsertStudentFromClaims } from '@/lib/studentService';
import { resolveJoinCampus } from '@/lib/campusLogic';
import { loadCampuses } from '@/lib/campusMaster';
import { resolveAppUrl } from '@/lib/url';

export const dynamic = 'force-dynamic';

/** Atomic single-use record of a signed token id (SET NX EX). Unsigned links have none. */
async function claimJti(key: string, ttl: number): Promise<boolean> {
  const redis = await ensureRedis();
  return (await redis.set(`schooljwt:jti:${key}`, '1', 'EX', ttl, 'NX')) === 'OK';
}

function redirect(req: Request, path: string) {
  const res = NextResponse.redirect(`${resolveAppUrl(req)}${path}`, 303);
  // The student's details / token are in this request's URL: never leak them onward.
  res.headers.set('Referrer-Policy', 'no-referrer');
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

function errorPath(code: string, field?: string) {
  const f = field && ERROR_FIELDS[field] ? `&field=${encodeURIComponent(field)}` : '';
  return `/student/error?reason=${encodeURIComponent(code)}${f}`;
}

/**
 * GET /join?… (rewritten here by middleware). Signed: `t=<jwt>`. Unsigned
 * (SCHOOL_JOIN_MODE=unsigned): `FirstName, LastName, SID, Grade, Division[, Campus]`.
 * Upserts the student by SID, starts their session and redirects to /student
 * (which drops the query from the address bar) — routing, waiting room,
 * attendance and admission are unchanged. Any failure → friendly page.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  // Only a top-level navigation (the school app opening the link) may sign a
  // student in; an embedded <img>/<iframe>/fetch from another page may not.
  if (!isJoinNavigation(req.headers)) {
    return new Response('Open this link from the school app.', {
      status: 400,
      headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    });
  }

  try {
    const redis = await ensureRedis();
    if (await joinRateLimited(clientIp(req), redis, joinRateLimitFromEnv())) {
      return redirect(req, errorPath('rate_limited'));
    }
  } catch {
    /* Redis down: fail open, the join itself reports 'unavailable' if needed */
  }

  try {
    const { claims, signed } = await resolveSchoolJoin(params, {
      mode: schoolJoinModeFromEnv(),
      jwt: schoolJwtConfigFromEnv(),
      claimJti,
    });
    try {
      if (await joinSidRateLimited(claims.studentId, await ensureRedis(), joinSidRateLimitFromEnv())) {
        throw new JoinTokenError('rate_limited', 'sid');
      }
    } catch (e) {
      if (e instanceof JoinTokenError) throw e;
      /* Redis down: fail open */
    }
    // No Campus in the link: the school's only campus (several → refused).
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
    return redirect(req, '/student');
  } catch (e) {
    const code = e instanceof JoinTokenError ? e.code : 'unavailable';
    const field = e instanceof JoinTokenError ? e.message.split(': ')[1] : undefined;
    if (!(e instanceof JoinTokenError)) console.error('school join failed', e instanceof Error ? e.message : e);
    else if (code !== 'expired' && code !== 'replayed') console.warn('school join rejected:', code, field ?? '');
    if (code === 'replayed') {
      // Reopening the same signed link on a browser that is already signed in: carry on.
      const pupil = await getPupil();
      if (pupil) return redirect(req, '/student');
    }
    return redirect(req, errorPath(code, field));
  }
}

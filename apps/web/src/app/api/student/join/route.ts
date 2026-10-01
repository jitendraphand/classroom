import { NextResponse } from 'next/server';
import { clearStudentCookie, getPupil, setActAsStudent, setPupilCookie } from '@/lib/auth';
import { ensureRedis } from '@/lib/redis';
import { JoinTokenError, schoolJwtConfigFromEnv, verifySchoolJoinToken } from '@/lib/schoolJwt';
import { upsertStudentFromClaims } from '@/lib/studentService';
import { resolveAppUrl } from '@/lib/url';

export const dynamic = 'force-dynamic';

/** Atomic single-use record of a token id (SET NX EX). */
async function claimJti(key: string, ttl: number): Promise<boolean> {
  const redis = await ensureRedis();
  return (await redis.set(`schooljwt:jti:${key}`, '1', 'EX', ttl, 'NX')) === 'OK';
}

function redirect(req: Request, path: string) {
  const res = NextResponse.redirect(`${resolveAppUrl(req)}${path}`, 303);
  // The token is in this request's URL: never leak it onward.
  res.headers.set('Referrer-Policy', 'no-referrer');
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

/**
 * GET /join?t=<jwt> (rewritten here by middleware). Verifies the school app's
 * signed token, upserts the student, starts their session and sends them to
 * /student, which routes them by the timetable. Any failure → friendly page.
 */
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('t');
  try {
    const claims = await verifySchoolJoinToken(token, schoolJwtConfigFromEnv(), claimJti);
    const student = await upsertStudentFromClaims(claims);
    // Shared devices: drop any previous student's class seat on this browser.
    await clearStudentCookie();
    await setPupilCookie(student);
    await setActAsStudent();
    return redirect(req, '/student');
  } catch (e) {
    const code = e instanceof JoinTokenError ? e.code : 'unavailable';
    if (!(e instanceof JoinTokenError)) console.error('school join failed', e instanceof Error ? e.message : e);
    else if (code !== 'expired' && code !== 'replayed') console.warn('school join rejected:', e.message);
    if (code === 'replayed') {
      // Reopening the same link on a browser that is already signed in: carry on.
      const pupil = await getPupil();
      if (pupil) return redirect(req, '/student');
    }
    return redirect(req, `/student/error?reason=${encodeURIComponent(code)}`);
  }
}

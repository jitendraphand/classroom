import { NextResponse, type NextRequest } from 'next/server';
import { checkCsrf, isCsrfExempt } from '@/lib/csrf';
import { hasUnsignedJoinParams } from '@/lib/joinParams';

/**
 * - `/join?t=<jwt>` (signed) or `/join?FirstName=…&SID=…&Grade=…&Division=…`
 *   (unsigned mode): the school app's join link. Rewritten (URL kept) to the
 *   route handler that checks it, sets the student session and redirects to
 *   /student, so the query never reaches a page/Referer or the address bar.
 * - Origin + content-type guard for every state-changing API call. See
 *   `lib/csrf.ts` for the rules and why SameSite cookies are not enough on
 *   sslip.io deploys.
 */
export function middleware(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;
  if (pathname === '/join' || pathname === '/join/') {
    if (searchParams.has('t') || hasUnsignedJoinParams(searchParams)) {
      const url = req.nextUrl.clone();
      url.pathname = '/api/student/join';
      return NextResponse.rewrite(url);
    }
    return NextResponse.next();
  }

  if (isCsrfExempt(pathname)) return NextResponse.next();
  const result = checkCsrf({
    method: req.method,
    headers: req.headers,
    configuredOrigins: [process.env.APP_URL, process.env.NEXT_PUBLIC_APP_URL],
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: result.status });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/api/:path*', '/join'],
};

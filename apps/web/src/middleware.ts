import { NextResponse, type NextRequest } from 'next/server';
import { checkCsrf, isCsrfExempt } from '@/lib/csrf';

/**
 * - `/join?t=<jwt>`: the school app's signed join link. Rewritten (URL kept)
 *   to the route handler that verifies the token, sets the student session
 *   and redirects to /student, so the token never reaches a page/Referer.
 * - Origin + content-type guard for every state-changing API call. See
 *   `lib/csrf.ts` for the rules and why SameSite cookies are not enough on
 *   sslip.io deploys.
 */
export function middleware(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;
  if (pathname === '/join' || pathname === '/join/') {
    if (searchParams.has('t')) {
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

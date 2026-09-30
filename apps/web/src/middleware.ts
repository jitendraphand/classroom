import { NextResponse, type NextRequest } from 'next/server';
import { checkCsrf } from '@/lib/csrf';

/**
 * Origin + content-type guard for every state-changing API call. See
 * `lib/csrf.ts` for the rules and why SameSite cookies are not enough on
 * sslip.io deploys.
 */
export function middleware(req: NextRequest) {
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
  matcher: '/api/:path*',
};

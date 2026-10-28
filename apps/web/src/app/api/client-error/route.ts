import { NextResponse } from 'next/server';
import { sanitizeClientErrorBody } from '@/lib/clientError';
import { clientIp, overRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Reports per client IP per minute; the rest are dropped (an error loop must not flood the logs). */
const PER_IP_PER_MINUTE = 10;
const MAX_BODY = 8_000;

/**
 * Classroom error-boundary reports -> one container-log line. No auth (the
 * boundary may run signed out), so it is size-capped and throttled per IP.
 */
export async function POST(req: Request) {
  const text = await req.text().catch(() => '');
  if (text.length > MAX_BODY) return NextResponse.json({ ok: false }, { status: 413 });
  if (await overRateLimit(`ratelimit:client-error:${clientIp(req)}`, PER_IP_PER_MINUTE, 60)) {
    return NextResponse.json({ ok: false, throttled: true }, { status: 429 });
  }
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* ignore */
  }
  const report = sanitizeClientErrorBody(body);
  if (!report) return NextResponse.json({ ok: false }, { status: 400 });
  console.error('[client-error]', JSON.stringify(report));
  return NextResponse.json({ ok: true });
}

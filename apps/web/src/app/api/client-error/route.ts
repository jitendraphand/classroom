import { NextResponse } from 'next/server';
import { sanitizeClientErrorBody } from '@/lib/clientError';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Classroom error-boundary reports -> one container-log line. No auth (best effort, capped). */
export async function POST(req: Request) {
  const text = await req.text().catch(() => '');
  if (text.length > 16_000) return NextResponse.json({ ok: false }, { status: 413 });
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

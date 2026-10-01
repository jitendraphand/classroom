import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { JOIN_ERROR_TEXT, type JoinErrorCode } from '@/lib/schoolJwt';

export const dynamic = 'force-dynamic';

export default async function JoinErrorPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const reason = (await searchParams).reason as JoinErrorCode | undefined;
  const text = (reason && JOIN_ERROR_TEXT[reason]) || JOIN_ERROR_TEXT.malformed;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10 sm:px-6">
      <Card className="text-center">
        <div
          className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/15 text-2xl ring-1 ring-amber-400/30"
          aria-hidden
        >
          !
        </div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">{text.title}</h1>
        <p className="mt-3 text-sm text-slate-300">{text.body}</p>
        {reason && <p className="mt-4 text-2xs uppercase tracking-wider text-slate-600">Code: {reason}</p>}
        <Link href="/" className="mt-6 inline-block text-sm text-slate-500 transition hover:text-slate-300">
          Home
        </Link>
      </Card>
    </main>
  );
}

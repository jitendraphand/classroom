import Link from 'next/link';
import { AppHeader } from '@/components/layout/AppHeader';
import { Card } from '@/components/ui/Card';
import { nameJoinAllowedFromEnv } from '@/lib/schoolJoin';

// Reads ALLOW_NAME_JOIN at request time (the page is tiny; no data loads).
export const dynamic = 'force-dynamic';

export default function HomePage() {
  const nameJoin = nameJoinAllowedFromEnv();
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10 sm:px-6">
      <AppHeader compact />
      <h1 className="font-display text-2xl font-semibold tracking-tight">Welcome to Classroom</h1>
      <Card className="mt-6">
        <h2 className="font-display text-lg font-semibold">Students</h2>
        <p className="mt-1 text-sm text-slate-400">
          {nameJoin
            ? 'Open your class from your school app, or tap Join the class and type your name.'
            : 'Open your class from your school app.'}
        </p>
        {/* TEMPORARY until the school app is integrated: remove with src/app/join-class. */}
        {nameJoin && (
          <Link href="/join-class" className="btn-primary mt-4 inline-flex w-full justify-center py-3 text-base">
            Join the class
          </Link>
        )}
      </Card>
      <Card className="mt-4">
        <h2 className="font-display text-lg font-semibold">Teachers and school staff</h2>
        <p className="mt-1 text-sm text-slate-400">Sign in to start your classes, see attendance and manage the school.</p>
        <Link href="/login" className="btn-primary mt-4 inline-flex w-full justify-center py-3 text-base">
          Staff login
        </Link>
      </Card>
    </main>
  );
}

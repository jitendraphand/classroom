import Link from 'next/link';
import { Card } from '@/components/ui/Card';

export const metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10 sm:px-6">
      <Card className="text-center">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Page not found</h1>
        <p className="mt-2 text-sm text-slate-400">
          This address does not exist. Students: open your class from your school app.
        </p>
        <Link href="/" className="btn-primary mt-6 inline-flex px-4 py-2 text-sm">
          Home
        </Link>
      </Card>
    </main>
  );
}

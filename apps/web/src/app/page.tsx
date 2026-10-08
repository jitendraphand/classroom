import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="light-landing flex min-h-screen items-center justify-center px-6">
      <nav className="flex w-full max-w-xs flex-col gap-3" aria-label="Home">
        <Link href="/login" className="landing-btn-primary w-full py-3 text-base">
          Staff login
        </Link>
      </nav>
    </main>
  );
}

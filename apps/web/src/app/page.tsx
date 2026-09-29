import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="light-landing flex min-h-screen items-center justify-center px-6">
      <nav className="flex w-full max-w-xs flex-col gap-3" aria-label="Home">
        <Link href="/login" className="landing-btn-secondary w-full py-3 text-base">
          Login
        </Link>
        <Link href="/register" className="landing-btn-primary w-full py-3 text-base">
          Register
        </Link>
        <Link href="/join" className="landing-btn-secondary w-full py-3 text-base">
          Join
        </Link>
      </nav>
    </main>
  );
}

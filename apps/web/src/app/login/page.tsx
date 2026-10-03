'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BackLink } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Card } from '@/components/ui/Card';
import { endedSessionCopy, isEndedReason, safeNextPath } from '@/lib/sessionClient';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);
  const [next, setNext] = useState<string | null>(null);

  // Read on the client (no useSearchParams, so the page stays static).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const reason = q.get('reason');
    if (isEndedReason(reason)) setNotice(endedSessionCopy(reason));
    setNext(safeNextPath(q.get('next')));
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.error || 'Login failed');
      return;
    }
    if (data.mustChangePassword) router.push('/account/password');
    else if (next && (data.role === 'admin') === next.startsWith('/admin')) router.push(next);
    else router.push(data.role === 'admin' ? '/admin' : '/teacher/dashboard');
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10 sm:px-6">
      <BackLink href="/">Home</BackLink>
      <Card>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Staff login</h1>
        <p className="mt-2 text-sm text-slate-400">Teachers and the school administrator sign in here.</p>
        {notice && (
          <div className="mt-4 rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 text-sm" role="status">
            <p className="font-semibold text-amber-100">{notice.title}</p>
            <p className="mt-1 text-amber-100/80">{notice.body}</p>
          </div>
        )}
        <p className="mt-2 text-xs text-slate-500">
          Signing in here signs this account out on any other device.
        </p>
        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <Input
            label="Email"
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <Input
            label="Password"
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && (
            <p className="text-sm text-danger-fg" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" fullWidth className="py-3" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
        <p className="mt-6 text-center text-sm text-slate-400">
          Teacher accounts are created by the school administrator.
        </p>
      </Card>
    </main>
  );
}

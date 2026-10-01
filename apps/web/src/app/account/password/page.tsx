'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { PageLoading } from '@/components/ui/Skeleton';
import { api } from '@/lib/clientFetch';

type Me = { role: 'admin' | 'teacher' | null; name?: string; email?: string; mustChangePassword?: boolean };

export default function ChangePasswordPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Me>('/api/auth/me').then(({ data }) => {
      if (data.role !== 'admin' && data.role !== 'teacher') router.replace('/login');
      else setMe(data);
    });
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (next !== confirm) {
      setError('The new passwords do not match.');
      return;
    }
    setBusy(true);
    const { ok, data } = await api<{ role: string }>('/api/auth/change-password', {
      body: { currentPassword: current, newPassword: next },
    });
    setBusy(false);
    if (!ok) {
      setError(data.error || 'Could not change password');
      return;
    }
    router.replace(data.role === 'admin' ? '/admin' : '/teacher/dashboard');
  }

  if (!me) return <PageLoading label="Loading…" />;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10 sm:px-6">
      <Card>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          {me.mustChangePassword ? 'Set your password' : 'Change password'}
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          {me.mustChangePassword
            ? 'You signed in with a temporary password. Choose your own password to continue.'
            : `Signed in as ${me.email}.`}
        </p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <Input
            label={me.mustChangePassword ? 'Temporary password' : 'Current password'}
            type="password"
            name="current"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
          <Input
            label="New password"
            type="password"
            name="new"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            hint="At least 10 characters."
            required
            minLength={10}
          />
          <Input
            label="Confirm new password"
            type="password"
            name="confirm"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
          {error && (
            <p className="text-sm text-danger-fg" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" fullWidth className="py-3" disabled={busy}>
            {busy ? 'Saving…' : 'Save password'}
          </Button>
          {!me.mustChangePassword && (
            <Button variant="ghost" fullWidth onClick={() => router.back()}>
              Cancel
            </Button>
          )}
        </form>
      </Card>
    </main>
  );
}

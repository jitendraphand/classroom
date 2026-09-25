'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BackLink } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';

export default function JoinLandingPage() {
  const router = useRouter();
  const [code, setCode] = useState('');

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10 sm:px-6">
      <BackLink href="/">Home</BackLink>
      <Card>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Join a class</h1>
        <p className="mt-2 text-sm text-slate-400">Enter the room code from your teacher.</p>
        <form
          className="mt-6 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) router.push(`/join/${code.trim().toUpperCase()}`);
          }}
        >
          <input
            className="input text-center font-display text-2xl font-semibold tracking-[0.35em] uppercase"
            placeholder="CODE"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={8}
            required
            aria-label="Room code"
            autoComplete="off"
          />
          <Button type="submit" fullWidth className="py-3">
            Continue
          </Button>
        </form>
      </Card>
    </main>
  );
}

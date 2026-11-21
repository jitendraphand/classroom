'use client';

// TEMPORARY "Join the class" form (see lib/joinClassForm.ts). Delete with the feature.
import { useEffect, useState } from 'react';
import { BackLink } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import type { FixedClass } from '@/lib/joinClassForm';

const NAME_MAX = 60;
const STORE_KEY = 'joinClass.name';
const NOT_AVAILABLE = 'Joining is not available right now. Please ask your teacher.';

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="label">{label}</p>
      <p className="rounded-xl border border-white/5 bg-white/[0.03] px-4 py-2.5 text-sm text-slate-200" aria-readonly="true">
        {value}
      </p>
    </div>
  );
}

export function JoinClassForm({ fixed }: { fixed: FixedClass | null }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORE_KEY);
      if (saved) setName(saved.slice(0, NAME_MAX));
    } catch {
      /* storage blocked */
    }
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!clean) return setError('Type your name.');
    if (clean.split(' ').length < 2) return setError('Type your first name and surname, e.g. Asha Patil.');
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/join-class', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: clean }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; redirect?: string; error?: string };
      if (res.ok && data.ok) {
        try {
          window.localStorage.setItem(STORE_KEY, clean);
        } catch {
          /* storage blocked */
        }
        window.location.assign(data.redirect || '/student');
        return;
      }
      setError(data.error || 'Something went wrong. Wait a moment and try again.');
    } catch {
      setError('No connection. Check your internet and try again.');
    }
    setBusy(false);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10 sm:px-6">
      <BackLink href="/">Home</BackLink>
      <Card>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Join the class</h1>
        {!fixed ? (
          <p className="mt-4 text-sm text-amber-200" role="alert">
            {NOT_AVAILABLE}
          </p>
        ) : (
          <form className="mt-6 space-y-4" onSubmit={submit} noValidate>
            <div>
              <label htmlFor="join-name" className="label">
                Your name
              </label>
              <input
                id="join-name"
                name="name"
                className="input py-3 text-base"
                placeholder="First name and surname"
                value={name}
                onChange={(e) => {
                  setName(e.target.value.slice(0, NAME_MAX));
                  if (error) setError(null);
                }}
                maxLength={NAME_MAX}
                autoComplete="name"
                autoCapitalize="words"
                autoFocus
                required
                aria-invalid={!!error}
                aria-describedby={error ? 'join-error' : undefined}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <ReadOnlyField label="Class" value={fixed.gradeLabel.match(/^\d+$/) ? `Grade ${fixed.gradeLabel}` : fixed.gradeLabel} />
              <ReadOnlyField label="Campus" value={fixed.campusLabel} />
            </div>
            <ReadOnlyField label="Division" value={fixed.divisionLabel} />
            {error && (
              <p id="join-error" className="text-sm text-danger-fg" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" fullWidth className="py-3 text-base" disabled={busy}>
              {busy ? 'Joining…' : 'Join'}
            </Button>
            <p className="text-center text-xs text-slate-500">Use the same name every time so your attendance is counted.</p>
          </form>
        )}
      </Card>
    </main>
  );
}

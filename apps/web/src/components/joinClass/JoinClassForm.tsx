'use client';

// TEMPORARY "Join the class" form (see lib/joinClassForm.ts). Delete with the feature.
import { useEffect, useMemo, useState } from 'react';
import { BackLink } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import type { JoinFormOptions, JoinFormPrefill } from '@/lib/joinClassForm';
import { NAME_MAX } from '@/lib/joinClassForm';

const STORE_KEY = 'joinClass.name';
const STORE_CLASS = 'joinClass.class';
const NOT_AVAILABLE = 'Joining is not available right now. Please ask your teacher.';

type StoredClass = { grade?: string; campus?: string; division?: string };

function SelectField({
  id,
  label,
  value,
  locked,
  options,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  locked: boolean;
  options: { name: string; label: string }[];
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <select
        id={id}
        name={id}
        className="input py-3 text-base"
        value={value}
        disabled={locked || options.length === 0}
        required
        onChange={(e) => onChange(e.target.value)}
      >
        {!value && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.name} value={o.name}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function JoinClassForm({
  options,
  prefill,
}: {
  options: JoinFormOptions | null;
  prefill: JoinFormPrefill | null;
}) {
  const [name, setName] = useState('');
  const [grade, setGrade] = useState(prefill?.grade ?? '');
  const [campus, setCampus] = useState(prefill?.campus ?? '');
  const [division, setDivision] = useState(prefill?.division ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const locked = prefill?.locked ?? { grade: false, campus: false, division: false };
  const foundations = useMemo(
    () => (options && grade ? options.foundationsByGrade[grade] ?? [] : []),
    [options, grade],
  );
  const available = Boolean(options && options.grades.length && options.campuses.length);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORE_KEY);
      if (saved) setName(saved.slice(0, NAME_MAX));
    } catch {
      /* storage blocked */
    }
    if (!options) return;
    let stored: StoredClass = {};
    try {
      stored = JSON.parse(window.localStorage.getItem(STORE_CLASS) || '{}') as StoredClass;
    } catch {
      stored = {};
    }
    setGrade((current) => {
      if (locked.grade && prefill?.grade) return prefill.grade;
      if (current && options.grades.some((g) => g.name === current)) return current;
      if (stored.grade && options.grades.some((g) => g.name === stored.grade)) return stored.grade;
      return prefill?.grade || options.grades[0]?.name || '';
    });
    setCampus((current) => {
      if (locked.campus && prefill?.campus) return prefill.campus;
      if (current && options.campuses.some((c) => c.name === current)) return current;
      if (stored.campus && options.campuses.some((c) => c.name === stored.campus)) return stored.campus;
      return prefill?.campus || options.campuses[0]?.name || '';
    });
  }, [options, prefill, locked.grade, locked.campus]);

  useEffect(() => {
    if (!options) return;
    const list = options.foundationsByGrade[grade] ?? [];
    setDivision((current) => {
      if (locked.division && prefill?.division && list.some((d) => d.name === prefill.division)) return prefill.division;
      if (current && list.some((d) => d.name === current)) return current;
      try {
        const stored = JSON.parse(window.localStorage.getItem(STORE_CLASS) || '{}') as StoredClass;
        if (stored.division && list.some((d) => d.name === stored.division)) return stored.division;
      } catch {
        /* ignore */
      }
      if (prefill?.division && list.some((d) => d.name === prefill.division)) return prefill.division;
      return list[0]?.name || '';
    });
  }, [options, grade, prefill, locked.division]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!clean) return setError('Type your name.');
    if (clean.split(' ').length < 2) return setError('Type your first name and surname, e.g. Asha Patil.');
    if (!grade || !campus || !division) return setError('Pick your grade, campus and foundation.');
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/join-class', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: clean, grade, campus, foundation: division }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; redirect?: string; error?: string };
      if (res.ok && data.ok) {
        try {
          window.localStorage.setItem(STORE_KEY, clean);
          window.localStorage.setItem(STORE_CLASS, JSON.stringify({ grade, campus, division }));
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
        {!available ? (
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
            <SelectField
              id="join-grade"
              label="Grade"
              value={grade}
              locked={locked.grade}
              options={options!.grades}
              onChange={(v) => {
                setGrade(v);
                if (error) setError(null);
              }}
              placeholder="Choose your grade"
            />
            <SelectField
              id="join-campus"
              label="Campus"
              value={campus}
              locked={locked.campus}
              options={options!.campuses}
              onChange={(v) => {
                setCampus(v);
                if (error) setError(null);
              }}
              placeholder="Choose your campus"
            />
            <SelectField
              id="join-foundation"
              label="Foundation"
              value={division}
              locked={locked.division}
              options={foundations}
              onChange={(v) => {
                setDivision(v);
                if (error) setError(null);
              }}
              placeholder="Choose your foundation"
            />
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

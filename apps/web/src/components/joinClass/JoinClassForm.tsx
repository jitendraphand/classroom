'use client';

// TEMPORARY "Join the class" form (see lib/joinClassForm.ts). Delete with the feature.
import { useEffect, useMemo, useState } from 'react';
import { BackLink } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import type { JoinFormOptions, JoinFormPrefill } from '@/lib/joinClassForm';

const FIRST_MAX = 50;
const LAST_MAX = 50;
const STORE_FIRST = 'joinClass.firstName';
const STORE_LAST = 'joinClass.lastName';
const STORE_LEGACY_NAME = 'joinClass.name';
const NOT_AVAILABLE = 'Joining is not available right now. Please ask your teacher.';
const PICK_ALL = 'Type your first name and last name, and select your grade, campus and foundation.';

function splitStoredName(name: string): { first: string; last: string } {
  const parts = name.trim().replace(/\s+/g, ' ').split(' ');
  const first = (parts.shift() ?? '').slice(0, FIRST_MAX);
  const last = parts.join(' ').slice(0, LAST_MAX);
  return { first, last };
}

function SelectField({
  id,
  label,
  value,
  locked,
  disabled,
  options,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  locked: boolean;
  disabled?: boolean;
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
        disabled={locked || disabled || options.length === 0}
        required
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {options.map((o) => (
          <option key={o.name} value={o.name}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function NameField({
  id,
  label,
  value,
  max,
  autoComplete,
  autoFocus,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  max: number;
  autoComplete: string;
  autoFocus?: boolean;
  error: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <input
        id={id}
        name={id}
        className="input py-3 text-base"
        placeholder={label}
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, max))}
        maxLength={max}
        autoComplete={autoComplete}
        autoCapitalize="words"
        autoFocus={autoFocus}
        required
        aria-invalid={error}
        aria-describedby={error ? 'join-error' : undefined}
      />
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
  const locked = prefill?.locked ?? { grade: false, campus: false, division: false };
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [grade, setGrade] = useState(locked.grade ? prefill?.grade ?? '' : '');
  const [campus, setCampus] = useState(locked.campus ? prefill?.campus ?? '' : '');
  const [division, setDivision] = useState(locked.division ? prefill?.division ?? '' : '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const foundations = useMemo(
    () => (options && grade ? options.foundationsByGrade[grade] ?? [] : []),
    [options, grade],
  );
  const available = Boolean(options && options.grades.length && options.campuses.length);
  const ready = Boolean(firstName.trim() && lastName.trim() && grade && campus && division);
  const nameError = Boolean(error && (error.toLowerCase().includes('first name') || error.toLowerCase().includes('last name') || error.toLowerCase().includes('your name')));

  useEffect(() => {
    try {
      const storedFirst = window.localStorage.getItem(STORE_FIRST);
      const storedLast = window.localStorage.getItem(STORE_LAST);
      if (storedFirst || storedLast) {
        if (storedFirst) setFirstName(storedFirst.slice(0, FIRST_MAX));
        if (storedLast) setLastName(storedLast.slice(0, LAST_MAX));
      } else {
        const legacy = window.localStorage.getItem(STORE_LEGACY_NAME);
        if (legacy) {
          const parts = splitStoredName(legacy);
          setFirstName(parts.first);
          setLastName(parts.last);
        }
      }
    } catch {
      /* storage blocked */
    }
  }, []);

  useEffect(() => {
    if (!options || locked.division) return;
    const list = options.foundationsByGrade[grade] ?? [];
    setDivision((current) => (current && list.some((d) => d.name === current) ? current : ''));
  }, [options, grade, locked.division]);

  function clearError() {
    if (error) setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const first = firstName.trim().replace(/\s+/g, ' ');
    const last = lastName.trim().replace(/\s+/g, ' ');
    if (!first) return setError('Type your first name.');
    if (!last) return setError('Type your last name.');
    if (!grade || !campus || !division) return setError('Select your grade, campus and foundation.');
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/join-class', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName: first, lastName: last, grade, campus, foundation: division }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; redirect?: string; error?: string };
      if (res.ok && data.ok) {
        try {
          window.localStorage.setItem(STORE_FIRST, first);
          window.localStorage.setItem(STORE_LAST, last);
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
            <NameField
              id="join-first-name"
              label="First name"
              value={firstName}
              max={FIRST_MAX}
              autoComplete="given-name"
              autoFocus
              error={nameError}
              onChange={(v) => {
                setFirstName(v);
                clearError();
              }}
            />
            <NameField
              id="join-last-name"
              label="Last name"
              value={lastName}
              max={LAST_MAX}
              autoComplete="family-name"
              error={nameError}
              onChange={(v) => {
                setLastName(v);
                clearError();
              }}
            />
            <SelectField
              id="join-grade"
              label="Grade"
              value={grade}
              locked={locked.grade}
              options={options!.grades}
              onChange={(v) => {
                setGrade(v);
                clearError();
              }}
              placeholder="Select grade"
            />
            <SelectField
              id="join-campus"
              label="Campus"
              value={campus}
              locked={locked.campus}
              options={options!.campuses}
              onChange={(v) => {
                setCampus(v);
                clearError();
              }}
              placeholder="Select campus"
            />
            <SelectField
              id="join-foundation"
              label="Foundation"
              value={division}
              locked={locked.division}
              disabled={!grade}
              options={foundations}
              onChange={(v) => {
                setDivision(v);
                clearError();
              }}
              placeholder="Select foundation"
            />
            {error && (
              <p id="join-error" className="text-sm text-danger-fg" role="alert">
                {error}
              </p>
            )}
            {!ready && !error && (
              <p className="text-sm text-slate-400" role="status">
                {PICK_ALL}
              </p>
            )}
            <Button type="submit" fullWidth className="py-3 text-base" disabled={busy || !ready}>
              {busy ? 'Joining…' : 'Join'}
            </Button>
            <p className="text-center text-xs text-slate-500">Use the same name every time so your attendance is counted.</p>
          </form>
        )}
      </Card>
    </main>
  );
}

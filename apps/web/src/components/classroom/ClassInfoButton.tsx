'use client';

import { useState } from 'react';

type Props = {
  teacherName?: string | null;
  subject?: string | null;
  audience?: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
};

function formatWhen(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function scheduledLabel(start?: string | null, end?: string | null): string | null {
  if (!start && !end) return null;
  if (start && end) return `${formatWhen(start)} – ${formatWhen(end)}`;
  return formatWhen((start || end) as string);
}

/** Small "i" that opens the class details (teacher, subject, audience, time). */
export function ClassInfoButton({ teacherName, subject, audience, scheduledStart, scheduledEnd }: Props) {
  const [open, setOpen] = useState(false);
  const when = scheduledLabel(scheduledStart, scheduledEnd);
  const rows = [
    teacherName ? { k: 'Teacher', v: teacherName } : null,
    subject ? { k: 'Subject', v: subject } : null,
    audience ? { k: 'Audience', v: audience } : null,
    when ? { k: 'Scheduled', v: when } : null,
  ].filter((row): row is { k: string; v: string } => !!row);

  return (
    <div className="relative">
      <button
        type="button"
        className="flex h-8 w-8 items-center justify-center rounded-full border border-white/20 bg-black/60 text-sm font-semibold italic text-white shadow-lift hover:bg-black/80"
        aria-label="Class info"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        i
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Class info"
          className="absolute left-0 top-10 z-[80] w-64 rounded-xl border border-white/15 bg-black/90 p-3 text-left text-xs text-slate-100 shadow-lift"
        >
          {rows.length === 0 ? (
            <p className="text-slate-400">Class info is not available yet.</p>
          ) : (
            <dl className="space-y-1.5">
              {rows.map((row) => (
                <div key={row.k}>
                  <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{row.k}</dt>
                  <dd className="text-slate-100">{row.v}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}

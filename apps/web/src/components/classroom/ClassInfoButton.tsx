'use client';

import { useState } from 'react';
import { formatDate, formatTimeRange } from '@/lib/timeFormat';
import { formatTeacherName } from '@/lib/teacherSalutation';

type Props = {
  teacherName?: string | null;
  teacherGender?: string | null;
  subject?: string | null;
  audience?: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  /** Where the details open: below the button (default) or above it (lower-corner placement). */
  placement?: 'down' | 'up';
};

/** "Wed 28 Oct, 09:40–10:25" (one format app-wide, lib/timeFormat). */
function scheduledLabel(start?: string | null, end?: string | null): string | null {
  if (!start && !end) return null;
  const day = formatDate(start || end);
  return day ? `${day}, ${formatTimeRange(start, end)}` : null;
}

/** Small "i" that opens the class details (teacher, subject, audience, time). */
export function ClassInfoButton({ teacherName, teacherGender, subject, audience, scheduledStart, scheduledEnd, placement = 'down' }: Props) {
  const [open, setOpen] = useState(false);
  const when = scheduledLabel(scheduledStart, scheduledEnd);
  const teacher = teacherName ? formatTeacherName(teacherName, teacherGender, 'plain') : '';
  const rows = [
    teacher ? { k: 'Teacher', v: teacher } : null,
    subject ? { k: 'Subject', v: subject } : null,
    audience ? { k: 'Audience', v: audience } : null,
    when ? { k: 'Scheduled', v: when } : null,
  ].filter((row): row is { k: string; v: string } => !!row);

  // 'up': no positioned wrapper, so the details anchor to the corner row
  // (.stage-bottom-left) and line up with its left edge; anchored to the "i"
  // they ran off the right edge of a portrait phone.
  return (
    <div className={placement === 'up' ? undefined : 'relative'}>
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
          data-placement={placement}
          className={`absolute left-0 z-[80] w-64 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-xl border border-white/15 bg-black/90 p-3 text-left text-xs text-slate-100 shadow-lift ${
            placement === 'up' ? 'bottom-10 max-h-[calc(100dvh-6rem)]' : 'top-10'
          }`}
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

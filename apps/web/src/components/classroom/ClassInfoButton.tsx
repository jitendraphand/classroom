'use client';

import { useRef, useState } from 'react';
import { formatDate, formatTimeRange } from '@/lib/timeFormat';
import { formatTeacherName } from '@/lib/teacherSalutation';

type Props = {
  teacherName?: string | null;
  teacherGender?: string | null;
  subject?: string | null;
  audience?: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  /**
   * Where the details open: below the button (default), above it (lower-corner
   * placement) or to its left (inside the right-hand meeting toolbar).
   */
  placement?: 'down' | 'up' | 'left';
  /** Extra rows after the class details (teacher: code, videos, students, live). */
  extra?: Array<{ k: string; v: string }>;
  /** Also open on hover / keyboard focus (teacher info button, Nov 25); tap still toggles. */
  hover?: boolean;
  /** Smaller button for toolbars. */
  compact?: boolean;
};

/** "Wed 28 Oct, 09:40–10:25" (one format app-wide, lib/timeFormat). */
function scheduledLabel(start?: string | null, end?: string | null): string | null {
  if (!start && !end) return null;
  const day = formatDate(start || end);
  return day ? `${day}, ${formatTimeRange(start, end)}` : null;
}

/** Small "i" that opens the class details (teacher, subject, audience, time). */
export function ClassInfoButton({
  teacherName,
  teacherGender,
  subject,
  audience,
  scheduledStart,
  scheduledEnd,
  placement = 'down',
  extra,
  hover = false,
  compact = false,
}: Props) {
  const [open, setOpen] = useState(false);
  // Pinned by a tap/click so a hover-out does not close what the user opened.
  const pinned = useRef(false);
  const when = scheduledLabel(scheduledStart, scheduledEnd);
  const teacher = teacherName ? formatTeacherName(teacherName, teacherGender, 'plain') : '';
  const rows = [
    teacher ? { k: 'Teacher', v: teacher } : null,
    subject ? { k: 'Subject', v: subject } : null,
    audience ? { k: 'Audience', v: audience } : null,
    when ? { k: 'Scheduled', v: when } : null,
    ...(extra ?? []),
  ].filter((row): row is { k: string; v: string } => !!row && !!row.v);

  // 'up': no positioned wrapper, so the details anchor to the corner row
  // (.stage-bottom-left) and line up with its left edge; anchored to the "i"
  // they ran off the right edge of a portrait phone.
  return (
    <div
      className={placement === 'up' ? undefined : 'relative'}
      onMouseEnter={hover ? () => setOpen(true) : undefined}
      onMouseLeave={hover ? () => !pinned.current && setOpen(false) : undefined}
    >
      <button
        type="button"
        className={`flex items-center justify-center rounded-full border border-white/20 bg-black/60 font-semibold italic text-white shadow-lift hover:bg-black/80 ${
          compact ? 'h-7 w-7 text-xs' : 'h-8 w-8 text-sm'
        }`}
        aria-label="Class info"
        title={hover ? undefined : 'Class info'}
        aria-expanded={open}
        data-testid="class-info-button"
        onFocus={hover ? () => setOpen(true) : undefined}
        onBlur={hover ? () => !pinned.current && setOpen(false) : undefined}
        onClick={() =>
          setOpen((v) => {
            // Tap / click toggles and pins; hover alone never pins.
            const next = hover ? !(v && pinned.current) : !v;
            pinned.current = hover && next;
            return next;
          })
        }
      >
        i
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Class info"
          data-placement={placement}
          className={`absolute z-[130] w-64 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-xl border border-white/15 bg-black/90 p-3 text-left text-xs text-slate-100 shadow-lift ${
            // prettier-ignore
            placement === 'up' ? 'bottom-10 left-0 max-h-[calc(100dvh-6rem)]' : placement === 'left' ? 'right-full top-0 mr-2 max-h-[calc(100dvh-1rem)]' : 'left-0 top-10'
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

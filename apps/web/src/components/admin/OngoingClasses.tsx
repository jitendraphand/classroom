'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconUsers, IconVideo } from '@/components/ui/Icons';
import { api } from '@/lib/clientFetch';
import { formatElapsed, type LiveClass } from '@/lib/liveClassesLogic';
import { formatTime } from '@/lib/timeFormat';
import { useSessionEnded } from '@/hooks/useSessionEnded';
import { CampusSelect, useGradeOptions } from '@/components/admin/GradePickers';
import { normalizeCampus } from '@/lib/grades';

/** How often the list (counts, new/ended classes) is refreshed. */
const POLL_MS = 5_000;
/** Cards per page. */
export const PAGE_SIZE = 12;

/** Ticking "now" for the elapsed-time badges (one timer for all cards). */
export function useNow(intervalMs = 1_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function matchesCampus(c: LiveClass, campus: string): boolean {
  if (!campus) return true;
  const list = c.campuses && c.campuses.length > 0 ? c.campuses : c.campus ? [c.campus] : [];
  return list.some((x) => normalizeCampus(x) === campus);
}

/**
 * Admin -> Live classes overview: lightweight metadata cards ONLY.
 * No LiveKit connection, audio, or video streams start until the admin opens a class.
 */
export function OngoingClasses() {
  const [classes, setClasses] = useState<LiveClass[] | null>(null);
  const [error, setError] = useState('');
  const now = useNow();
  const gradeOptions = useGradeOptions();
  const [campus, setCampus] = useState('');
  const filtered = classes && campus ? classes.filter((c) => matchesCampus(c, campus)) : classes;
  const [page, setPage] = useState(0);
  const pages = filtered ? Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)) : 1;
  const safePage = Math.min(page, pages - 1);
  const shown = filtered ? filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE) : filtered;

  // Signed out / replaced (StaffSessionGuard shows why): stop polling.
  const sessionEnded = useSessionEnded();
  const [stopped, setStopped] = useState(false);

  const load = useCallback(async () => {
    const { ok, status, data } = await api<{ classes: LiveClass[] }>('/api/admin/live');
    if (ok) {
      setClasses(data.classes);
      setError('');
    } else if (status === 401) {
      setStopped(true);
      setClasses([]);
    } else setError(data.error || 'Could not load ongoing classes');
  }, []);

  useEffect(() => {
    if (sessionEnded || stopped) return;
    void load();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    const onVis = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load, sessionEnded, stopped]);

  return (
    <section aria-labelledby="ongoing-heading" className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="ongoing-heading" className="font-display text-lg font-semibold">
          Live now {filtered ? `(${filtered.length})` : ''}
        </h2>
        {(gradeOptions.campuses.length > 1 || campus) && (
          <CampusSelect className="w-44 py-1.5 text-sm" value={campus} onChange={setCampus} options={gradeOptions} emptyLabel="All campuses" />
        )}
        <p className="text-xs text-slate-500">
          No video or audio streams here · click a class to watch and listen · refreshes every {POLL_MS / 1000}s
        </p>
      </div>
      {error && (
        <p className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm text-danger-fg" role="alert">
          {error}
        </p>
      )}
      {!shown ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : shown.length === 0 ? (
        <EmptyState
          icon={<IconVideo size={28} />}
          title={campus ? `No ${campus} classes are live right now` : 'No classes are live right now'}
          description="Classes appear here as soon as a teacher starts them."
        />
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {shown.map((c) => (
            <li key={`${c.code}:${c.sessionId}`}>
              <LiveClassCard c={c} now={now} />
            </li>
          ))}
        </ul>
      )}
      {pages > 1 && (
        <nav className="flex items-center justify-center gap-3 text-sm" aria-label="Pages">
          <button type="button" className="rounded-lg border border-white/10 px-3 py-1 disabled:opacity-40" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
            Previous
          </button>
          <span className="tabular-nums text-slate-400">
            Page {safePage + 1} of {pages}
          </span>
          <button type="button" className="rounded-lg border border-white/10 px-3 py-1 disabled:opacity-40" disabled={safePage >= pages - 1} onClick={() => setPage(safePage + 1)}>
            Next
          </button>
        </nav>
      )}
    </section>
  );
}

function LiveClassCard({ c, now }: { c: LiveClass; now: number }) {
  const elapsed = formatElapsed(now - new Date(c.startedAt).getTime());
  const students = `${c.studentCount} student${c.studentCount === 1 ? '' : 's'}`;

  return (
    <Link
      href={`/admin/live/${encodeURIComponent(c.code)}`}
      data-testid="live-class-card"
      className="group flex h-full flex-col justify-between gap-3 rounded-2xl border border-white/10 bg-surface-2 p-4 transition hover:border-brand-400/60 focus-visible:border-brand-400 focus-visible:outline-none"
      aria-label={`Open ${c.subject || c.title} (${c.gradeDivision}, ${c.teacherName})`}
    >
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 text-[11px] font-medium">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/15 px-2 py-0.5 text-red-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-400" aria-hidden />
            Live · <span className="font-mono tabular-nums">{elapsed}</span>
          </span>
          {c.teacherConnected === false ? (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-amber-300">Teacher away</span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-slate-300" title="Students connected now">
              <IconUsers size={12} />
              <span className="tabular-nums">{c.studentCount}</span>
              <span className="sr-only">{students}</span>
            </span>
          )}
        </div>
        <div>
          <p className="truncate text-base font-semibold text-white group-hover:text-brand-200">{c.subject || c.title}</p>
          <p className="mt-0.5 line-clamp-2 text-xs text-slate-300">{c.gradeDivision}</p>
        </div>
      </div>

      <div className="space-y-1.5 border-t border-white/5 pt-2.5 text-xs text-slate-400">
        <p className="truncate text-slate-200">{c.teacherName}</p>
        <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
          <span>Started {formatTime(c.startedAt)}</span>
          <span className="font-medium text-brand-300 group-hover:text-brand-200">Open live view →</span>
        </div>
      </div>
    </Link>
  );
}

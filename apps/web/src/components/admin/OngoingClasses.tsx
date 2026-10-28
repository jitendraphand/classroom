'use client';

import { LiveKitRoom } from '@livekit/components-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StudentViewStage } from '@/components/classroom/StudentViewStage';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconUsers, IconVideo } from '@/components/ui/Icons';
import { api } from '@/lib/clientFetch';
import { formatElapsed, type LiveClass } from '@/lib/liveClassesLogic';
import { useSessionEnded } from '@/hooks/useSessionEnded';
import { CampusSelect, useGradeOptions } from '@/components/admin/GradePickers';
import { normalizeCampus } from '@/lib/grades';

/** How often the list (counts, new/ended classes) is refreshed. */
const POLL_MS = 5_000;
/** Tiles per page (run 4: 30 classes at once made the page take 9.4 s). */
export const PAGE_SIZE = 12;
/** Preview connections opened at the same time (the rest wait their turn). */
const MAX_CONCURRENT_CONNECTS = 3;

let connectSlots = MAX_CONCURRENT_CONNECTS;
const connectQueue: (() => void)[] = [];
/** Wait for a free preview-connect slot; call the returned release when connected (or failed). */
function acquireConnectSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = () => {
      connectSlots--;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        connectSlots++;
        connectQueue.shift()?.();
      });
    };
    if (connectSlots > 0) grant();
    else connectQueue.push(grant);
  });
}

/** Ticking "now" for the elapsed-time overlays (one timer for all tiles). */
export function useNow(intervalMs = 1_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Admin → Ongoing classes: a responsive grid of live, muted, low-quality tiles. */
export function OngoingClasses() {
  const [classes, setClasses] = useState<LiveClass[] | null>(null);
  const [error, setError] = useState('');
  const now = useNow();
  const gradeOptions = useGradeOptions();
  const [campus, setCampus] = useState('');
  const filtered = classes && campus ? classes.filter((c) => normalizeCampus(c.campus ?? '') === campus) : classes;
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
          Muted previews of what students see · refreshes every {POLL_MS / 1000}s · click a class to sit in
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
              <LiveClassTile c={c} now={now} />
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

const PREVIEW_ROOM_OPTIONS = {
  adaptiveStream: true,
  dynacast: false,
  disconnectOnPageLeave: true,
} as const;
const PREVIEW_CONNECT_OPTIONS = { autoSubscribe: false, peerConnectionTimeout: 20_000 } as const;

/** Connect only while the tile is (nearly) on screen. */
function useInView<T extends Element>() {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(([e]) => setInView(!!e?.isIntersecting), { rootMargin: '0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return { ref, inView };
}

function LiveClassTile({ c, now }: { c: LiveClass; now: number }) {
  const { ref, inView } = useInView<HTMLAnchorElement>();
  const [conn, setConn] = useState<{ token: string; serverUrl: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Admin signed in elsewhere: stop the preview for good (no reconnect loop).
  const sessionEnded = useSessionEnded();

  useEffect(() => {
    if (!inView || sessionEnded) {
      setConn(null);
      return;
    }
    let cancelled = false;
    let release: (() => void) | null = null;
    void acquireConnectSlot().then((rel) => {
      release = rel;
      if (cancelled) return rel();
      // Free the slot once the connection had time to come up.
      window.setTimeout(rel, 2_500);
      return api<{ token: string; serverUrl: string }>(`/api/admin/live/${encodeURIComponent(c.code)}/token`, {
        body: { mode: 'preview' },
      }).then(({ ok, data }) => {
        if (cancelled) return;
        if (ok) {
          setConn({ token: data.token, serverUrl: data.serverUrl });
          setFailed(false);
        } else setFailed(true);
      });
    });
    return () => {
      cancelled = true;
      release?.();
    };
  }, [inView, c.code, c.sessionId, attempt, sessionEnded]);

  const reconnectLater = useCallback(() => {
    setConn(null);
    if (!sessionEnded) setTimeout(() => setAttempt((n) => n + 1), 4_000);
  }, [sessionEnded]);

  const elapsed = formatElapsed(now - new Date(c.startedAt).getTime());
  const students = `${c.studentCount} student${c.studentCount === 1 ? '' : 's'}`;

  return (
    <Link
      ref={ref}
      href={`/admin/live/${encodeURIComponent(c.code)}`}
      className="group block overflow-hidden rounded-2xl border border-white/10 bg-surface-2 transition hover:border-brand-400/60 focus-visible:border-brand-400 focus-visible:outline-none"
      aria-label={`Join ${c.title} (${c.gradeDivision}, ${c.teacherName}) as observer`}
    >
      <div className="pointer-events-none relative aspect-video w-full bg-ink-950">
        {conn && !sessionEnded ? (
          <LiveKitRoom
            token={conn.token}
            serverUrl={conn.serverUrl}
            connect
            audio={false}
            video={false}
            options={PREVIEW_ROOM_OPTIONS}
            connectOptions={PREVIEW_CONNECT_OPTIONS}
            onDisconnected={reconnectLater}
            onError={reconnectLater}
            className="h-full w-full"
          >
            <StudentViewStage code={c.code} mode="preview" />
          </LiveKitRoom>
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-slate-500">
            {failed ? 'Preview unavailable' : 'Connecting preview…'}
          </div>
        )}
        <div className="absolute right-2 top-2 flex items-center gap-2 rounded-lg bg-black/65 px-2 py-1 text-[11px] font-medium text-white backdrop-blur">
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" aria-hidden />
            <span className="font-mono tabular-nums" title="Time since the class started">
              {elapsed}
            </span>
          </span>
          <span className="flex items-center gap-1" title="Students connected now">
            <IconUsers size={12} />
            <span className="tabular-nums">{c.studentCount}</span>
            <span className="sr-only">{students}</span>
          </span>
        </div>
        {c.teacherConnected === false && (
          <span className="absolute left-2 top-2 rounded-lg bg-amber-500/80 px-2 py-0.5 text-[11px] font-medium text-black">
            Teacher away
          </span>
        )}
      </div>
      <div className="px-3 py-2.5">
        <p className="truncate text-sm font-medium text-white group-hover:text-brand-200">{c.title}</p>
        <p className="truncate text-xs text-slate-400">
          {c.title.includes(c.gradeDivision) ? c.teacherName : `${c.gradeDivision} · ${c.teacherName}`}
        </p>
      </div>
    </Link>
  );
}


'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/clientFetch';
import type { LiveClass } from '@/lib/liveClassesLogic';

/** One-line "N classes live now" link for the admin home page (list only, no media). */
export function LiveNowBanner() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ classes: LiveClass[] }>('/api/admin/live').then(({ ok, data }) => {
        if (alive && ok) setCount(data.classes.length);
      });
    void load();
    const id = setInterval(() => document.visibilityState === 'visible' && void load(), 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  if (!count) return null;
  return (
    <Link
      href="/admin/live"
      className="flex items-center justify-between gap-3 rounded-2xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-sm text-white transition hover:border-red-400/50"
    >
      <span className="flex items-center gap-2">
        <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" aria-hidden />
        {count} class{count === 1 ? ' is' : 'es are'} live now
      </span>
      <span className="text-xs text-slate-300">View ongoing classes →</span>
    </Link>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/clientFetch';

type Row = { key: string; subject: string; audience: string; teacherName: string; start: string; tag: string; lateMinutes?: number };

/** Classes that should be live by now but have no teacher yet (from the Today board). */
export function LateClasses() {
  const [late, setLate] = useState<Row[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (document.visibilityState !== 'visible') return;
      void api<{ classes: Row[] }>('/api/admin/today').then(({ ok, data }) => {
        if (!cancelled && ok) setLate(data.classes.filter((c) => c.tag === 'late'));
      });
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (!late.length) return null;
  return (
    <section className="mb-6 rounded-2xl border border-amber-400/30 bg-amber-500/10 p-4" aria-labelledby="late-heading">
      <h2 id="late-heading" className="font-semibold text-amber-100">
        Should be live now ({late.length})
      </h2>
      <ul className="mt-2 space-y-1 text-sm text-amber-50">
        {late.map((c) => (
          <li key={c.key}>
            <span className="font-medium">{c.subject}</span> · {c.audience} · {c.teacherName}{' '}
            <span className="text-amber-200">— started at {c.start}, teacher not in yet ({c.lateMinutes ?? 0} min)</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

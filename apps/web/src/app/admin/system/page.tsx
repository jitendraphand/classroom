'use client';

import Link from 'next/link';
import { AdminShell, useAdminMe } from '@/components/admin/AdminShell';
import { visibleSettingsItems } from '@/lib/adminSections';

export default function SettingsPage() {
  return (
    <AdminShell title="Settings">
      <Hub />
    </AdminShell>
  );
}

function Hub() {
  const me = useAdminMe();
  if (!me) return null;
  const items = visibleSettingsItems(me.privileges, me.kind);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {items.map((l) => (
        <Link key={l.href} href={l.href} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 hover:border-brand-400/40">
          <p className="font-semibold text-white">{l.title}</p>
          <p className="mt-1 text-sm text-slate-400">{l.body}</p>
        </Link>
      ))}
    </div>
  );
}

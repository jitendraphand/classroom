'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { api } from '@/lib/clientFetch';
import type { PrivilegeSet } from '@/lib/privileges';

const LINKS: { href: string; title: string; body: string; show: (kind: string, p: PrivilegeSet) => boolean }[] = [
  { href: '/admin/teachers', title: 'Teachers', body: 'Add, edit and delete teacher accounts.', show: (_k, p) => p.manageTeachers },
  { href: '/admin/timetable', title: 'Scheduling', body: 'Weekly slots, substitutes and extra classes.', show: (_k, p) => p.schedule },
  { href: '/admin/students', title: 'Students', body: 'Add and delete students.', show: (_k, p) => p.manageSchool },
  { href: '/admin/grades', title: 'Campus, grade and division', body: 'The school structure students and classes use.', show: (_k, p) => p.manageSchool },
  { href: '/admin/reports', title: 'Attendance reports', body: 'Data exports for the academic year.', show: (_k, p) => p.viewReports },
  { href: '/admin/system/years', title: 'Academic years', body: 'The year labels (e.g. 2026-27) stored on every class.', show: (_k, p) => p.manageSchool },
  { href: '/admin/system/settings', title: 'Class size and microphones', body: 'Optional caps. Leave them empty for no limit.', show: (_k, p) => p.manageSchool },
  { href: '/admin/system/admins', title: 'Sub-administrators', body: 'Only the system administrator can manage these.', show: (k) => k === 'SYSTEM' },
];

export default function SystemControlPage() {
  return (
    <AdminShell title="System Control">
      <Hub />
    </AdminShell>
  );
}

function Hub() {
  const [links, setLinks] = useState<typeof LINKS | null>(null);
  useEffect(() => {
    api<{ kind: string; privileges: PrivilegeSet }>('/api/auth/me').then(({ data }) => {
      if (!data.privileges) return;
      setLinks(LINKS.filter((l) => l.show(data.kind, data.privileges)));
    });
  }, []);
  if (!links) return <p className="text-sm text-slate-400">Loading…</p>;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {links.map((l) => (
        <Link key={l.href} href={l.href} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 hover:border-brand-400/40">
          <p className="font-semibold text-white">{l.title}</p>
          <p className="mt-1 text-sm text-slate-400">{l.body}</p>
        </Link>
      ))}
    </div>
  );
}

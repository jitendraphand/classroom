'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { AppHeader } from '@/components/layout/AppHeader';
import { SwitchViewButton } from '@/components/layout/SwitchViewButton';
import { Button } from '@/components/ui/Button';
import { PageLoading } from '@/components/ui/Skeleton';
import { api } from '@/lib/clientFetch';
import { cn } from '@/lib/cn';
import { loginHref } from '@/lib/sessionClient';
import { visibleAdminTabs, type PrivilegeSet } from '@/lib/privileges';

const TABS = [
  { id: 'today' as const, href: '/admin', label: "Today's classes" },
  { id: 'live' as const, href: '/admin/live', label: 'Live dashboard' },
  { id: 'performance' as const, href: '/admin/performance', label: 'Teacher performance' },
  { id: 'system' as const, href: '/admin/system', label: 'System Control' },
];

const SYSTEM_PREFIXES = ['/admin/system', '/admin/teachers', '/admin/timetable', '/admin/students', '/admin/grades', '/admin/reports'];

function tabForPath(pathname: string) {
  if (pathname.startsWith('/admin/live')) return 'live' as const;
  if (pathname.startsWith('/admin/performance')) return 'performance' as const;
  if (SYSTEM_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))) return 'system' as const;
  if (pathname === '/admin') return 'today' as const;
  return 'system' as const;
}

/** Admin page frame: checks the admin session, renders header + the four tabs. */
export function AdminShell({ children, title }: { children: ReactNode; title: string }) {
  const router = useRouter();
  const pathname = usePathname() || '/admin';
  const [me, setMe] = useState<{ email: string; tabs: Array<(typeof TABS)[number]['id']>; linkedTeacher: boolean } | null>(null);

  useEffect(() => {
    api<{ role: string; email: string; mustChangePassword?: boolean; kind?: string; privileges?: PrivilegeSet; linkedTeacherId?: string | null }>('/api/auth/me').then(({ data }) => {
      if (data.role !== 'admin') router.replace(loginHref((data as { reason?: unknown }).reason, window.location.pathname));
      else if (data.mustChangePassword) router.replace('/account/password');
      else {
        const tabs = data.privileges && data.kind ? visibleAdminTabs(data.privileges, data.kind) : (['today', 'live', 'performance', 'system'] as const);
        setMe({ email: data.email, tabs: [...tabs], linkedTeacher: !!data.linkedTeacherId });
      }
    });
  }, [router]);

  useEffect(() => {
    if (!me) return;
    const here = tabForPath(pathname);
    if (me.tabs.includes(here)) return;
    const first = TABS.find((t) => me.tabs.includes(t.id));
    if (first) router.replace(first.href);
  }, [me, pathname, router]);

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    router.push('/login');
  }

  if (!me) return <PageLoading label="Loading admin…" />;

  return (
    <main className="page-shell">
      <AppHeader
        compact
        homeHref="/admin"
        subtitle="School administration"
        right={
          <>
            {me.linkedTeacher && <SwitchViewButton to="teacher" />}
            {!me.linkedTeacher && (
              <Link href="/account/password" className="btn-ghost px-3 py-1.5 text-xs">
                Change password
              </Link>
            )}
            <Button variant="secondary" size="sm" onClick={logout}>
              Log out
            </Button>
          </>
        }
      />
      <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-white/10 pb-px" aria-label="Admin sections">
        {TABS.filter((n) => me.tabs.includes(n.id)).map((n) => {
          const active = tabForPath(pathname) === n.id;
          return (
            <Link
              key={n.href}
              href={n.href}
              className={cn(
                '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition',
                active ? 'border-brand-400 text-white' : 'border-transparent text-slate-400 hover:text-white'
              )}
            >
              {n.label}
            </Link>
          );
        })}
      </nav>
      <h1 className="mb-5 font-display text-2xl font-semibold tracking-tight">{title}</h1>
      {children}
      <p className="mt-10 text-xs text-slate-500">Signed in as {me.email}</p>
    </main>
  );
}

/** One-time secret display (temporary passwords). */
export function SecretOnce({ title, lines, onClose }: { title: string; lines: [string, string][]; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const secret = lines[lines.length - 1]?.[1] ?? '';
  return (
    <div className="mb-6 rounded-2xl border border-amber-400/30 bg-amber-500/10 p-5" role="status">
      <p className="font-semibold text-amber-100">{title}</p>
      <dl className="mt-3 space-y-1 text-sm">
        {lines.map(([k, v]) => (
          <div key={k} className="flex flex-wrap gap-2">
            <dt className="w-36 text-slate-400">{k}</dt>
            <dd className="break-all font-mono text-white">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-amber-100/80">
        This is shown only once. Give it to the teacher privately; they must change it at first sign-in.
      </p>
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(secret);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy password'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

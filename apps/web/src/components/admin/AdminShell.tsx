'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { AppHeader } from '@/components/layout/AppHeader';
import { SwitchViewButton } from '@/components/layout/SwitchViewButton';
import { Button } from '@/components/ui/Button';
import { PageLoading } from '@/components/ui/Skeleton';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { ADMIN_SECTIONS, pageAccess, sectionForPath, visibleAdminSections, type AdminSectionId } from '@/lib/adminSections';
import { api } from '@/lib/clientFetch';
import { cn } from '@/lib/cn';
import { allPrivileges, type PrivilegeSet } from '@/lib/privileges';
import { loginHref } from '@/lib/sessionClient';

export type AdminMe = { email: string; kind: string; privileges: PrivilegeSet; linkedTeacher: boolean; sections: AdminSectionId[] };

const AdminContext = createContext<AdminMe | null>(null);

/** The signed-in admin (inside AdminShell): pages hide what this admin may not do. */
export function useAdminMe(): AdminMe | null {
  return useContext(AdminContext);
}

/** Admin page frame: checks the admin session, renders the header and the section tabs. */
export function AdminShell({ children, title }: { children: ReactNode; title: string }) {
  const router = useRouter();
  const pathname = usePathname() || '/admin';
  const [me, setMe] = useState<AdminMe | null>(null);
  useDocumentTitle(title);

  useEffect(() => {
    api<{ role: string; email: string; mustChangePassword?: boolean; kind?: string; privileges?: PrivilegeSet; linkedTeacherId?: string | null }>('/api/auth/me').then(({ data }) => {
      if (data.role !== 'admin') router.replace(loginHref((data as { reason?: unknown }).reason, window.location.pathname));
      else if (data.mustChangePassword) router.replace('/account/password');
      else {
        const kind = data.kind || 'SYSTEM';
        const privileges = data.privileges ?? allPrivileges(true);
        setMe({ email: data.email, kind, privileges, linkedTeacher: !!data.linkedTeacherId, sections: visibleAdminSections(privileges, kind) });
      }
    });
  }, [router]);

  // Landing on /admin without access to Today (e.g. a students-only sub-admin): go to the first section they have.
  useEffect(() => {
    if (!me || pathname !== '/admin' || me.sections.includes('today')) return;
    const first = ADMIN_SECTIONS.find((s) => me.sections.includes(s.id));
    if (first) router.replace(first.href);
  }, [me, pathname, router]);

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    router.push('/login');
  }

  if (!me) return <PageLoading label="Loading admin…" />;
  const access = pageAccess(pathname, me.privileges, me.kind);
  const active = sectionForPath(pathname).id;

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
        {ADMIN_SECTIONS.filter((s) => me.sections.includes(s.id)).map((s) => (
          <Link
            key={s.id}
            href={s.href}
            aria-current={active === s.id ? 'page' : undefined}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition',
              active === s.id ? 'border-brand-400 text-white' : 'border-transparent text-slate-400 hover:text-white'
            )}
          >
            {s.label}
          </Link>
        ))}
      </nav>
      <h1 className="mb-5 font-display text-2xl font-semibold tracking-tight">{title}</h1>
      {access.ok ? (
        <AdminContext.Provider value={me}>{children}</AdminContext.Provider>
      ) : (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6" role="status">
          <p className="font-semibold text-white">You don’t have access to this page</p>
          <p className="mt-1 text-sm text-slate-400">
            It needs the “{access.needs}” permission. Ask the system administrator if you need it.
          </p>
        </div>
      )}
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

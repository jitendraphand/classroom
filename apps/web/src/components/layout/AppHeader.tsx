import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function LogoMark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-indigo-600 font-display text-sm font-bold text-white shadow-glow',
        className
      )}
    >
      C
    </div>
  );
}

export function AppHeader({
  right,
  compact,
  subtitle,
}: {
  right?: ReactNode;
  compact?: boolean;
  subtitle?: string;
}) {
  return (
    <header
      className={cn(
        'flex items-center justify-between gap-4',
        compact ? 'mb-6' : 'mb-10'
      )}
    >
      <Link href="/" className="group flex items-center gap-3 focus-visible:rounded-xl">
        <LogoMark />
        <div>
          <p className="font-display text-base font-semibold tracking-tight text-white group-hover:text-brand-200 [.light-landing_&]:text-slate-900 [.light-landing_&]:group-hover:text-brand-700">
            Classroom
          </p>
          <p className="text-2xs text-slate-500">
            {subtitle || 'Live teaching · selective video'}
          </p>
        </div>
      </Link>
      {right && <div className="flex flex-wrap items-center justify-end gap-2">{right}</div>}
    </header>
  );
}

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="mb-6 inline-flex items-center gap-1.5 text-sm text-slate-400 transition hover:text-white"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M15 18l-6-6 6-6"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {children}
    </Link>
  );
}

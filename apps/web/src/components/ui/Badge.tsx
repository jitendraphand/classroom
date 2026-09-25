import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'violet' | 'sky';

const tones: Record<Tone, string> = {
  neutral: 'bg-white/5 text-slate-300 border border-white/10',
  brand: 'bg-brand-500/15 text-brand-200 border border-brand-400/20',
  success: 'bg-emerald-500/15 text-emerald-200 border border-emerald-400/20',
  warning: 'bg-amber-500/15 text-amber-100 border border-amber-400/20',
  danger: 'bg-red-500/15 text-red-200 border border-red-400/20',
  violet: 'bg-violet-500/15 text-violet-200 border border-violet-400/20',
  sky: 'bg-sky-500/15 text-sky-200 border border-sky-400/20',
};

export function Badge({
  children,
  tone = 'neutral',
  className,
  pulse,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
  pulse?: boolean;
}) {
  return (
    <span className={cn('badge', tones[tone], className)}>
      {pulse && (
        <span className="indicator-pulse">
          <span />
        </span>
      )}
      {children}
    </span>
  );
}

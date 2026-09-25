import { cn } from '@/lib/cn';

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} aria-hidden />;
}

export function PageLoading({ label = 'Loading…' }: { label?: string }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6">
      <div className="flex items-center gap-3 text-sm text-slate-400">
        <span className="indicator-pulse">
          <span />
        </span>
        {label}
      </div>
      <div className="flex w-full max-w-sm flex-col gap-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-10 w-2/3" />
      </div>
    </main>
  );
}

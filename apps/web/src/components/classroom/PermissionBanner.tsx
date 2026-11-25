'use client';

import type { MediaAccessIssue } from '@/lib/permissions';

/**
 * Inline, non-destructive media permission / hardware banner. Keeps the user
 * in class (listen/view only) and shows browser-specific steps + a 1-tap retry
 * button inside a real user gesture.
 */
export function PermissionBanner({
  issues,
  onRetryCamera,
  onRetryMic,
  onDismissCamera,
  onDismissMic,
  className,
}: {
  issues: MediaAccessIssue[];
  onRetryCamera?: () => void;
  onRetryMic?: () => void;
  onDismissCamera?: () => void;
  onDismissMic?: () => void;
  className?: string;
}) {
  if (!issues.length) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="permission-banner"
      className={
        className ??
        'fixed left-1/2 top-3 z-[85] flex w-[min(94vw,36rem)] -translate-x-1/2 flex-col gap-2 rounded-xl border border-amber-400/35 bg-surface-1/95 px-4 py-3 text-xs text-slate-100 shadow-lift backdrop-blur'
      }
    >
      {issues.map((issue) => {
        const retry = issue.media === 'camera' ? onRetryCamera : onRetryMic;
        const dismiss = issue.media === 'camera' ? onDismissCamera : onDismissMic;
        return (
          <div
            key={issue.media}
            data-testid={`permission-issue-${issue.media}`}
            className="flex flex-wrap items-start gap-3 border-b border-white/10 pb-2 last:border-b-0 last:pb-0"
          >
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="font-semibold text-amber-200">{issue.title}</p>
              <p className="text-slate-200">{issue.message}</p>
              <p className="text-[11px] text-slate-300">{issue.hint}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {issue.canRetry && retry && (
                <button
                  type="button"
                  data-no-auto-fullscreen
                  data-testid={`retry-${issue.media}`}
                  onClick={retry}
                  className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-400"
                >
                  {issue.kind === 'needs-gesture'
                    ? issue.media === 'microphone'
                      ? 'Allow microphone'
                      : 'Allow camera'
                    : 'Try again'}
                </button>
              )}
              {dismiss && (
                <button
                  type="button"
                  data-no-auto-fullscreen
                  onClick={dismiss}
                  className="px-1.5 py-1 text-xs font-medium text-slate-400 hover:text-white"
                >
                  Dismiss
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

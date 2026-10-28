'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button';

type Props = {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** Red confirm button for destructive actions (default); primary for the rest. */
  tone?: 'danger' | 'primary';
  /** The user must type this (e.g. the name) before the button enables. */
  typeToConfirm?: string;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
};

/** The one confirmation modal: destructive admin actions and "are you sure?" questions alike. */
export function ConfirmDialog({ title, children, confirmLabel, tone = 'danger', typeToConfirm, onConfirm, onClose }: Props) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const ready = !typeToConfirm || typed.trim().toLowerCase() === typeToConfirm.trim().toLowerCase();
  return (
    <dialog
      ref={ref}
      className="confirm-dialog w-[min(92vw,28rem)] rounded-2xl border border-white/10 bg-slate-900 p-0 text-slate-100 shadow-2xl backdrop:bg-black/60"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      aria-labelledby="confirm-title"
    >
      <form
        method="dialog"
        className="space-y-4 p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!ready || busy) return;
          setBusy(true);
          try {
            await onConfirm();
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2 id="confirm-title" className="font-display text-lg font-semibold text-white">
          {title}
        </h2>
        <div className="space-y-2 whitespace-pre-line text-sm text-slate-300">{children}</div>
        {typeToConfirm && (
          <label className="block text-sm">
            <span className="label">
              Type <span className="font-semibold text-white">{typeToConfirm}</span> to confirm
            </span>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus aria-label="Type to confirm" />
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant={tone === 'danger' ? 'danger' : 'primary'} disabled={!ready || busy}>
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}

export type ConfirmOptions = {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
};

/**
 * Promise-style confirm with the app's dialog instead of window.confirm():
 *   const [confirm, confirmDialog] = useConfirm();
 *   if (!(await confirm({ title: 'Delete X?', confirmLabel: 'Delete' }))) return;
 *   ... render {confirmDialog} somewhere in the page.
 */
export function useConfirm() {
  const [request, setRequest] = useState<{ opts: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);
  const confirm = useCallback(
    (opts: ConfirmOptions) => new Promise<boolean>((resolve) => setRequest({ opts, resolve })),
    []
  );
  const dialog = request ? (
    <ConfirmDialog
      title={request.opts.title}
      confirmLabel={request.opts.confirmLabel}
      tone={request.opts.tone}
      onConfirm={() => {
        request.resolve(true);
        setRequest(null);
      }}
      onClose={() => {
        request.resolve(false);
        setRequest(null);
      }}
    >
      {request.opts.body}
    </ConfirmDialog>
  ) : null;
  return [confirm, dialog] as const;
}

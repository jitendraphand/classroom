'use client';

import { Button } from '@/components/ui/Button';
import { api } from '@/lib/clientFetch';

/** Shared confirmation for ending a live class as an admin. */
export function EndClassDialog({
  open,
  busy,
  classLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  busy?: boolean;
  classLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-end-class-title"
        data-testid="admin-end-class-confirm"
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-surface-1 p-6 text-center shadow-lift"
      >
        <p id="admin-end-class-title" className="font-display text-lg font-semibold">
          End this class for everyone?
        </p>
        {classLabel && <p className="mt-2 text-sm text-slate-400">{classLabel}</p>}
        <p className="mt-2 text-xs text-slate-500">
          Students and the teacher will be disconnected, and attendance will be saved.
        </p>
        <div className="mt-5 flex justify-center gap-3">
          <Button variant="danger" onClick={onConfirm} disabled={busy} data-testid="admin-end-class-confirm-yes">
            {busy ? 'Ending…' : 'End class'}
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

export async function requestAdminEndClass(code: string): Promise<{ ok: boolean; status: number; error?: string }> {
  const { ok, status, data } = await api<{ error?: string }>(`/api/admin/live/${encodeURIComponent(code)}/end`, {
    method: 'POST',
    body: {},
  });
  return { ok, status, error: data?.error };
}

'use client';

import { useCallback } from 'react';
import { roomFetch } from '@/lib/classroomClient';

/**
 * Student drawing permission (whiteboard only): request / cancel (student),
 * allow / revoke / clear (teacher). Returns an error message or null.
 * Drawing on a screen share was removed (Nov 26): the server refuses it.
 */
export function useDrawingActions(code: string) {
  const call = useCallback(
    async (body: Record<string, unknown>) => {
      const res = await roomFetch(code, '/draw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => null);
      if (!res) return 'Network error';
      if (res.ok) return null;
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return data.error || `Failed (${res.status})`;
    },
    [code]
  );
  return {
    allow: (participantId: string) => call({ action: 'allow', participantId }),
    revoke: (participantId?: string) => call({ action: 'revoke', participantId }),
    clear: () => call({ action: 'clear' }),
    request: (on: boolean) => call({ action: on ? 'request' : 'cancel' }),
  };
}

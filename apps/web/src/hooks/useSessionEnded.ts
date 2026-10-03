'use client';

import { useEffect, useState } from 'react';
import { SESSION_ENDED_EVENT } from '@/lib/sessionClient';

/** True once StaffSessionGuard reports that this tab's teacher/admin session ended (replaced or revoked). */
export function useSessionEnded(): boolean {
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    const on = () => setEnded(true);
    window.addEventListener(SESSION_ENDED_EVENT, on);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, on);
  }, []);
  return ended;
}

'use client';

import { useIdleLogout } from '@/hooks/useIdleLogout';

/** Mount once in the root layout to enforce idle logout for all pages. */
export function SessionIdleGuard() {
  useIdleLogout();
  return null;
}

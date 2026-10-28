'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/clientFetch';
import { hasPrivilege, type Privilege, type PrivilegeSet } from '@/lib/privileges';

type Me = { kind?: string; privileges?: PrivilegeSet };

/**
 * The signed-in admin's privileges, for hiding actions they cannot use.
 * `can()` is false until /api/auth/me answers, so a button never flashes up
 * for an account that is not allowed to press it. The API still enforces.
 */
export function useAdminPrivileges() {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    let live = true;
    void api<Me>('/api/auth/me').then(({ ok, data }) => {
      if (live) setMe(ok ? data : {});
    });
    return () => {
      live = false;
    };
  }, []);
  const can = (p: Privilege) => !!me?.kind && !!me.privileges && hasPrivilege(me.privileges, me.kind, p);
  return { loaded: me !== null, isSystem: me?.kind === 'SYSTEM', can };
}

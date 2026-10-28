'use client';

import { useEffect } from 'react';

export const APP_NAME = 'Classroom';

/** "Teachers · Classroom" (same template as app/layout.tsx metadata). */
export function pageTitle(title: string): string {
  return `${title} · ${APP_NAME}`;
}

/**
 * Browser tab title for client pages ("Teachers · Classroom"), so tabs, history
 * and screen readers can tell pages apart. Server pages use `metadata.title`
 * with the same template (app/layout.tsx).
 */
export function useDocumentTitle(title: string | null | undefined) {
  useTabTitle(title ? pageTitle(title) : null);
}

/** Sets the whole tab title and keeps it while the component is mounted. */
export function useTabTitle(full: string | null | undefined) {
  useEffect(() => {
    if (!full) return;
    const apply = () => {
      if (document.title !== full) document.title = full;
    };
    apply();
    // Next streams the layout's metadata <title> in after the page mounts,
    // which put the default "Classroom" back: re-apply when the head changes.
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, [full]);
}

'use client';

import { useEffect } from 'react';

/**
 * Host document for the teacher "Share HUD" popup window.
 *
 * `window.open('', ...)` produces a document with an **opaque (null) origin**,
 * so the popup's `fetch()` calls are cross-origin and the browser omits the
 * session cookies — every HUD action (chat, hands, mute) would 401. Loading a
 * real same-origin URL gives the popup a normal origin, after which cookies are
 * attached and the existing room APIs work unchanged.
 *
 * This page intentionally renders nothing. The HUD is portalled in by
 * `useShareHud()` once this document finishes loading.
 */
export default function HudHostPage() {
  useEffect(() => {
    document.title = 'Class controls';
  }, []);

  return (
    <main
      aria-hidden
      style={{
        height: '100dvh',
        margin: 0,
        background: '#0d1219',
        color: '#eef2ff',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <p style={{ fontSize: 13, opacity: 0.6 }}>Loading class controls…</p>
    </main>
  );
}

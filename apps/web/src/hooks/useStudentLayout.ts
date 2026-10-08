'use client';

import { useEffect, useState } from 'react';

/**
 * Student classroom layout — ONE design on every device, OS and browser
 * (phone, tablet, desktop; Chrome, Safari, Edge, Firefox, Samsung Internet):
 *
 * - the shared screen (or the waiting message) fills the stage;
 * - the student controls are a vertical panel on the RIGHT edge;
 * - the teacher's video is a floating, draggable, minimisable pane;
 * - chat is a floating window that opens/closes from the controls.
 *
 * Only sizes follow the viewport (CSS clamp() and the pure box below); there
 * are no user-agent or device branches. Browsers without element fullscreen
 * (iPhone Safari) get the same look as a fixed, scroll-locked
 * "pseudo-fullscreen" page (see usePseudoFullscreen).
 */

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Compact chat text below this viewport size (same layout, denser). */
export function compactViewport(vw: number, vh: number): boolean {
  return vh < 520 || vw < 640;
}

/**
 * Pure: the student chat window box. Bottom-left corner (the controls are on
 * the right), sized to the viewport so the shared screen stays visible:
 * ≈ 17–20% of a phone screen, ≈ 13% of a laptop screen.
 */
export function studentChatBox(vw: number, vh: number, rightReserve = 72) {
  const width = Math.round(clamp(vw * 0.3, 200, 340));
  const height = Math.round(clamp(Math.min(vh * 0.5, vw * 0.6), 160, 420));
  return {
    width: Math.min(width, Math.max(160, vw - rightReserve - 16)),
    height,
    x: 8,
    y: Math.max(8, vh - height - 8),
  };
}

export function useViewport() {
  const [vp, setVp] = useState(() =>
    typeof window === 'undefined' ? { w: 1280, h: 800 } : { w: window.innerWidth, h: window.innerHeight }
  );
  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    on();
    window.addEventListener('resize', on);
    window.addEventListener('orientationchange', on);
    return () => {
      window.removeEventListener('resize', on);
      window.removeEventListener('orientationchange', on);
    };
  }, []);
  return vp;
}

/**
 * Pseudo-fullscreen for browsers without the Fullscreen API on elements
 * (iPhone Safari): lock page scrolling/bounce so the class fills the visible
 * viewport exactly like fullscreen elsewhere. CSS: html.pseudo-fullscreen.
 */
export function usePseudoFullscreen(on: boolean) {
  useEffect(() => {
    if (!on || typeof document === 'undefined') return;
    const html = document.documentElement;
    html.classList.add('pseudo-fullscreen');
    // Nudge mobile Safari to collapse its toolbar.
    window.scrollTo(0, 0);
    return () => html.classList.remove('pseudo-fullscreen');
  }, [on]);
}

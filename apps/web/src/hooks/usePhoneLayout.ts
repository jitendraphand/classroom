'use client';

import { useEffect, useState } from 'react';

export type PhoneLayout = 'landscape' | 'portrait' | null;

/**
 * Pure: phone-sized viewport and its orientation. Landscape phones are short
 * (≤ 500 px tall), portrait phones are narrow (≤ 640 px wide). Anything else
 * is a tablet / desktop layout (null).
 */
export function phoneLayout(w: number, h: number): PhoneLayout {
  if (!w || !h) return null;
  if (w > h && h <= 500) return 'landscape';
  if (h >= w && w <= 640) return 'portrait';
  return null;
}

export function usePhoneLayout(): PhoneLayout {
  const [layout, setLayout] = useState<PhoneLayout>(() =>
    typeof window === 'undefined' ? null : phoneLayout(window.innerWidth, window.innerHeight)
  );
  useEffect(() => {
    const on = () => setLayout(phoneLayout(window.innerWidth, window.innerHeight));
    on();
    window.addEventListener('resize', on);
    window.addEventListener('orientationchange', on);
    return () => {
      window.removeEventListener('resize', on);
      window.removeEventListener('orientationchange', on);
    };
  }, []);
  return layout;
}

/** Bottom room kept free for the portrait control pill (and its muted caption). */
export const PORTRAIT_CONTROLS_RESERVE = 100;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Pure: student chat sheet box for a phone layout. Short on purpose so the
 * shared screen and the teacher's drawing stay visible (target ≈ 20% of the
 * screen; the desktop panel on tablets is ≈ 13%).
 *  - Landscape: a narrow card in the bottom-left corner (the control rail is
 *    on the right). ≈ 17% of 844×390 / 915×412.
 *  - Portrait: a short full-width strip just above the control pill, i.e. in
 *    the letterbox under a 16:9 share. ≈ 21% of 390×844 / 412×915.
 */
export function phoneChatBox(layout: PhoneLayout, vw: number, vh: number) {
  if (layout === 'landscape') {
    const width = Math.round(clamp(vw * 0.28, 200, 260));
    const height = Math.round(clamp(vh * 0.62, 170, 280));
    return { width, height, x: 8, y: Math.max(8, vh - height - 8) };
  }
  if (layout === 'portrait') {
    const height = Math.round(clamp(vh * 0.22, 160, 210));
    const width = Math.max(200, vw - 16);
    return { width, height, x: 8, y: Math.max(8, vh - height - PORTRAIT_CONTROLS_RESERVE) };
  }
  return null;
}

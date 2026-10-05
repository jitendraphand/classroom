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

/** Pure: student chat sheet box for a phone layout (never the whole stage). */
export function phoneChatBox(layout: PhoneLayout, vw: number, vh: number) {
  if (layout === 'landscape') {
    // Side panel on the left; the control rail sits on the right.
    return { width: Math.round(Math.min(vw * 0.46, 360)), height: Math.max(160, vh - 16), x: 8, y: 8 };
  }
  if (layout === 'portrait') {
    const height = Math.round(vh * 0.5);
    return { width: Math.max(200, vw - 16), height, x: 8, y: Math.max(8, vh - height - 120) };
  }
  return null;
}

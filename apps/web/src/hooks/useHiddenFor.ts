'use client';

import { useEffect, useState } from 'react';

/**
 * True once the page has been hidden (background tab, minimised browser,
 * locked phone) for at least `ms`; false again as soon as it is visible.
 */
export function useHiddenFor(ms: number): boolean {
  const [long, setLong] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (document.hidden) {
        timer = setTimeout(() => setLong(true), ms);
      } else {
        setLong(false);
      }
    };
    update();
    document.addEventListener('visibilitychange', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      if (timer) clearTimeout(timer);
    };
  }, [ms]);
  return long;
}

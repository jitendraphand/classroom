'use client';

import { useEffect, useState } from 'react';

/** `value`, but a true→false change only takes effect after `graceMs` (false→true is immediate). */
export function useTrueWithGrace(value: boolean, graceMs: number): boolean {
  const [held, setHeld] = useState(value);
  useEffect(() => {
    if (value) {
      setHeld(true);
      return;
    }
    const t = setTimeout(() => setHeld(false), graceMs);
    return () => clearTimeout(t);
  }, [value, graceMs]);
  return value || held;
}

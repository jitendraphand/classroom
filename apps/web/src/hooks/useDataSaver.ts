'use client';

import { useCallback, useEffect, useState } from 'react';
import { DATA_SAVER_KEY, initialDataSaver, parseDataSaver, type DataSaverMode } from '@/lib/dataSaver';
import { mediaProfile } from '@/lib/videoQuality';

const EVT = 'classroom-data-saver';

/** Shared (all components, persisted per device) data-saver mode. */
export function useDataSaver(): [DataSaverMode, (m: DataSaverMode) => void] {
  const [mode, setMode] = useState<DataSaverMode>(() => {
    // No choice saved on this device: the deployment's media profile and the
    // browser's network hints decide (lib/dataSaver initialDataSaver).
    const conn = typeof navigator !== 'undefined'
      ? (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
      : undefined;
    const fallback: DataSaverMode = initialDataSaver(mediaProfile(), conn);
    try {
      const saved = localStorage.getItem(DATA_SAVER_KEY);
      return saved == null ? fallback : parseDataSaver(saved);
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    const on = (e: Event) => setMode(parseDataSaver((e as CustomEvent).detail));
    window.addEventListener(EVT, on);
    return () => window.removeEventListener(EVT, on);
  }, []);
  const set = useCallback((m: DataSaverMode) => {
    try {
      localStorage.setItem(DATA_SAVER_KEY, m);
    } catch {
      /* ignore */
    }
    window.dispatchEvent(new CustomEvent(EVT, { detail: m }));
  }, []);
  return [mode, set];
}

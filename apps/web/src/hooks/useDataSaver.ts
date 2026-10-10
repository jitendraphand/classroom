'use client';

import { useCallback, useEffect, useState } from 'react';
import { DATA_SAVER_KEY, parseDataSaver, type DataSaverMode } from '@/lib/dataSaver';

const EVT = 'classroom-data-saver';

/** Shared (all components, persisted per device) data-saver mode. */
export function useDataSaver(): [DataSaverMode, (m: DataSaverMode) => void] {
  const [mode, setMode] = useState<DataSaverMode>(() => {
    try {
      return parseDataSaver(localStorage.getItem(DATA_SAVER_KEY));
    } catch {
      return 'off';
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

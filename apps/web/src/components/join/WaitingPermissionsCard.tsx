'use client';

import { useEffect, useState } from 'react';
import {
  buildMediaIssue,
  queryMediaPermission,
  requestSeparatePermission,
  type MediaAccessIssue,
  type PermissionStateEx,
} from '@/lib/permissions';

/**
 * Optional, non-blocking camera & microphone pre-check while waiting to be
 * admitted. Requests camera and microphone separately on a tap so denying one
 * never blocks the other, and never holds up joining the class.
 */
export function WaitingPermissionsCard() {
  const [camState, setCamState] = useState<PermissionStateEx>('unknown');
  const [micState, setMicState] = useState<PermissionStateEx>('unknown');
  const [camIssue, setCamIssue] = useState<MediaAccessIssue | null>(null);
  const [micIssue, setMicIssue] = useState<MediaAccessIssue | null>(null);
  const [busyKind, setBusyKind] = useState<'camera' | 'microphone' | null>(null);

  useEffect(() => {
    let active = true;
    const cleanups: Array<() => void> = [];
    void (async () => {
      const cam = await queryMediaPermission('camera');
      if (!active) return;
      setCamState(cam.state);
      if (cam.state === 'denied') {
        setCamIssue(buildMediaIssue({ media: 'camera', permState: 'denied' }));
      }
      if (cam.status) {
        const onChange = () => {
          const next = cam.status!.state as PermissionStateEx;
          setCamState(next);
          if (next === 'granted') setCamIssue(null);
        };
        cam.status.addEventListener?.('change', onChange);
        cleanups.push(() => cam.status?.removeEventListener?.('change', onChange));
      }

      const mic = await queryMediaPermission('microphone');
      if (!active) return;
      setMicState(mic.state);
      if (mic.state === 'denied') {
        setMicIssue(buildMediaIssue({ media: 'microphone', permState: 'denied' }));
      }
      if (mic.status) {
        const onChange = () => {
          const next = mic.status!.state as PermissionStateEx;
          setMicState(next);
          if (next === 'granted') setMicIssue(null);
        };
        mic.status.addEventListener?.('change', onChange);
        cleanups.push(() => mic.status?.removeEventListener?.('change', onChange));
      }
    })();
    return () => {
      active = false;
      cleanups.forEach((fn) => fn());
    };
  }, []);

  async function testPermission(kind: 'camera' | 'microphone') {
    if (busyKind) return;
    setBusyKind(kind);
    const res = await requestSeparatePermission(kind);
    setBusyKind(null);
    if (res.ok) {
      if (kind === 'camera') {
        setCamState('granted');
        setCamIssue(null);
      } else {
        setMicState('granted');
        setMicIssue(null);
      }
    } else {
      if (kind === 'camera') {
        if (res.issue.kind === 'denied') setCamState('denied');
        setCamIssue(res.issue);
      } else {
        if (res.issue.kind === 'denied') setMicState('denied');
        setMicIssue(res.issue);
      }
    }
  }

  return (
    <div
      data-testid="waiting-permissions"
      className="mt-5 rounded-xl border border-edge bg-surface-0/60 px-3.5 py-3 text-left text-xs"
    >
      <p className="font-medium text-slate-300">Check camera &amp; mic before class starts (optional)</p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void testPermission('camera')}
          disabled={busyKind !== null || camState === 'granted'}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-medium transition ${
            camState === 'granted'
              ? 'border-emerald-400/35 bg-emerald-500/15 text-emerald-200'
              : camState === 'denied'
                ? 'border-amber-400/40 bg-amber-500/15 text-amber-100 hover:bg-amber-500/25'
                : 'border-edge bg-surface-2 text-slate-200 hover:bg-surface-1'
          }`}
        >
          <span>{camState === 'granted' ? 'Camera ready' : busyKind === 'camera' ? 'Checking camera…' : 'Allow camera'}</span>
        </button>
        <button
          type="button"
          onClick={() => void testPermission('microphone')}
          disabled={busyKind !== null || micState === 'granted'}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-medium transition ${
            micState === 'granted'
              ? 'border-emerald-400/35 bg-emerald-500/15 text-emerald-200'
              : micState === 'denied'
                ? 'border-amber-400/40 bg-amber-500/15 text-amber-100 hover:bg-amber-500/25'
                : 'border-edge bg-surface-2 text-slate-200 hover:bg-surface-1'
          }`}
        >
          <span>{micState === 'granted' ? 'Mic ready' : busyKind === 'microphone' ? 'Checking mic…' : 'Allow mic'}</span>
        </button>
      </div>
      {(camIssue || micIssue) && (
        <div className="mt-2.5 space-y-1.5 text-[11px] leading-relaxed text-amber-100/90">
          {camIssue && (
            <p>
              <strong className="text-amber-200">{camIssue.title}:</strong> {camIssue.hint}
            </p>
          )}
          {micIssue && (
            <p>
              <strong className="text-amber-200">{micIssue.title}:</strong> {micIssue.hint}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

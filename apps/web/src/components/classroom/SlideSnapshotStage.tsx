'use client';

import { useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, type RemoteParticipant } from 'livekit-client';
import { IconScreen } from '@/components/ui/Icons';
import { roomFetch } from '@/lib/classroomClient';
import { senderKind } from '@/lib/realtimePackets';
import {
  SNAPSHOT_FETCH_SPREAD_MS,
  SNAPSHOT_SAFETY_POLL_MS,
  SNAPSHOT_TOPIC,
  decodeSnapshotPacket,
} from '@/lib/slideSnapshot';

/**
 * Student stage in "Audio only" while the teacher shares the screen: the
 * latest still picture of the share (lib/slideSnapshot) instead of the live
 * video. Downloads a picture only when the server says a new one exists
 * (spread over a few seconds so a class does not fetch at once), with a slow
 * safety poll; an unchanged picture costs a 304.
 */
export function SlideSnapshotStage({ code }: { code: string }) {
  const room = useRoomContext();
  const [url, setUrl] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const etagRef = useRef<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const show = (next: string | null) => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = next;
      setUrl(next);
    };
    const fetchNow = async () => {
      try {
        const headers: Record<string, string> = {};
        if (etagRef.current) headers['If-None-Match'] = etagRef.current;
        const res = await roomFetch(code, '/snapshot', { headers, cache: 'no-store' });
        if (stopped) return;
        if (res.status === 304) return;
        if (res.status === 204) {
          etagRef.current = null;
          show(null);
          return;
        }
        if (!res.ok) return;
        const blob = await res.blob();
        if (stopped) return;
        etagRef.current = res.headers.get('ETag');
        show(URL.createObjectURL(blob));
        setUpdatedAt(Date.now());
      } catch {
        /* offline: the next push or poll retries */
      }
    };
    const fetchSpread = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void fetchNow(), Math.floor(Math.random() * SNAPSHOT_FETCH_SPREAD_MS));
    };
    void fetchNow();
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic !== SNAPSHOT_TOPIC || senderKind(participant?.identity) !== 'server') return;
      let raw: unknown = null;
      try {
        raw = JSON.parse(new TextDecoder().decode(payload));
      } catch {
        return;
      }
      const p = decodeSnapshotPacket(raw);
      if (!p) return;
      if (p.ver === 0) {
        etagRef.current = null;
        show(null);
        return;
      }
      if (etagRef.current === `"${p.ver}"`) return;
      fetchSpread();
    };
    room?.on(RoomEvent.DataReceived, onData);
    const poll = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void fetchNow();
    }, SNAPSHOT_SAFETY_POLL_MS);
    return () => {
      stopped = true;
      room?.off(RoomEvent.DataReceived, onData);
      clearInterval(poll);
      if (timer) clearTimeout(timer);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [room, code]);

  return (
    <div className="relative flex h-full w-full flex-col items-center justify-center bg-ink-950" data-testid="audio-only-stage">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- a blob: URL, not an optimisable asset
        <img src={url} alt="Your teacher's shared screen (still picture)" className="h-full w-full object-contain" data-testid="slide-snapshot" />
      ) : (
        <div className="flex flex-col items-center gap-3 px-6 text-center text-slate-300">
          <IconScreen size={32} />
          <p className="max-w-sm text-sm">
            Your teacher is sharing their screen. A still picture appears here when it is ready.
          </p>
        </div>
      )}
      <p
        className="pointer-events-none absolute inset-x-3 bottom-3 mx-auto w-fit max-w-[92%] rounded-full bg-black/70 px-3 py-1 text-center text-[11px] font-semibold text-white"
        aria-live="polite"
      >
        Audio only: still picture{updatedAt ? ', updates when the screen changes' : ''}. Tap <strong>Quality</strong> for the live screen.
      </p>
    </div>
  );
}

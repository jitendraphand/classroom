'use client';

/**
 * Class sound that the browser blocked (echo audit, Nov 25). Phones (iOS
 * Safari above all) refuse to start audio a page did not get a tap for; a
 * student who joins muted with the camera off then hears nothing, and
 * LiveKit only retries when the tab is hidden and shown again. Any tap or key
 * on the page starts it, and returning to the foreground resumes suspended
 * playback on iOS Safari; until then a button says so.
 */
import { StartAudio, useRoomContext } from '@livekit/components-react';
import { useEffect } from 'react';

export const START_AUDIO_LABEL = 'Tap to turn on class sound';

export function ClassAudioUnlock() {
  const room = useRoomContext();
  useEffect(() => {
    if (!room) return;
    const unlock = () => {
      if (!room.canPlaybackAudio) void room.startAudio().catch(() => undefined);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') unlock();
    };
    const opts = { capture: true, passive: true } as const;
    document.addEventListener('pointerdown', unlock, opts);
    document.addEventListener('keydown', unlock, opts);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', unlock);
    return () => {
      document.removeEventListener('pointerdown', unlock, opts);
      document.removeEventListener('keydown', unlock, opts);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', unlock);
    };
  }, [room]);
  return (
    <StartAudio
      label={START_AUDIO_LABEL}
      className="fixed left-1/2 top-3 z-[80] -translate-x-1/2 rounded-full border border-amber-400/50 bg-surface-1/95 px-4 py-2 text-sm font-semibold text-amber-200 shadow-lift backdrop-blur"
    />
  );
}

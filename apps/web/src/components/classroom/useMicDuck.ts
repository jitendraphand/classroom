'use client';
/**
 * B1 on the web teacher: while a share sends computer (tab) sound, duck the
 * teacher mic when that sound is loud and the teacher is not talking over it
 * (speaker bleed → students hear the video twice). See lib/micDuck.ts.
 */
import { useEffect, useRef } from 'react';
import { Track, type LocalAudioTrack, type LocalParticipant } from 'livekit-client';
import { DUCK_IDLE, HEADPHONES_HINT, MicDuckProcessor, duckStep, trackLevelMeter } from '@/lib/micDuck';

export function useMicDuck(enabled: boolean, participant: LocalParticipant | undefined, shareAudio: () => LocalAudioTrack | null, onHint: (text: string) => void) {
  const hintRef = useRef(onHint);
  hintRef.current = onHint;
  const shareRef = useRef(shareAudio);
  shareRef.current = shareAudio;
  useEffect(() => {
    if (!enabled || !participant) return;
    let active: { mic: LocalAudioTrack; share: LocalAudioTrack; ctx: AudioContext; proc: MicDuckProcessor; stopMeter: () => void; timer: number } | null = null;
    let busy = false;
    let hinted = false;
    const detach = async () => {
      const a = active;
      active = null;
      if (!a) return;
      window.clearInterval(a.timer);
      a.stopMeter();
      await a.mic.stopProcessor().catch(() => undefined);
      await a.ctx.close().catch(() => undefined);
    };
    const check = async () => {
      if (busy) return;
      busy = true;
      try {
        const mic = (participant.getTrackPublication(Track.Source.Microphone)?.track as LocalAudioTrack | undefined) ?? null;
        const share = shareRef.current();
        const want = !!mic && !!share && share.mediaStreamTrack?.readyState === 'live';
        if (active && (!want || active.mic !== mic || active.share !== share)) await detach();
        if (want && !active && mic && share) {
          const ctx = new AudioContext({ latencyHint: 'interactive' });
          mic.setAudioContext(ctx);
          const proc = new MicDuckProcessor();
          await mic.setProcessor(proc as never);
          const meter = trackLevelMeter(ctx, share.mediaStreamTrack);
          let state = DUCK_IDLE;
          const timer = window.setInterval(() => {
            const next = duckStep(state, meter.db(), proc.micDb(), performance.now());
            if (next.gain !== state.gain) proc.setGain(next.gain);
            if (next.everDucked && !hinted) {
              hinted = true;
              hintRef.current(HEADPHONES_HINT);
            }
            state = next;
          }, 50);
          active = { mic, share, ctx, proc, stopMeter: meter.stop, timer };
        }
      } catch (e) {
        console.warn('mic duck', e); // never block the mic
      } finally {
        busy = false;
      }
    };
    const iv = window.setInterval(() => void check(), 700);
    void check();
    return () => {
      window.clearInterval(iv);
      void detach();
    };
  }, [enabled, participant]);
}

/**
 * Computer sound ("share audio") for a screen share.
 *
 * Root cause (E2E 2026-10-09, students heard no video audio): the loopback
 * stream was requested with getDisplayMedia(), which Chromium only allows with
 * transient user activation in the CALLING window. Video mode is toggled from
 * the floating control panel (another window) or switched on automatically, so
 * the request was rejected (NotAllowedError → null) and nothing was published.
 * Auto Video mode never asked at all. The class window now uses Electron's
 * desktop getUserMedia constraints (chromeMediaSource: 'desktop'), which need
 * no gesture and give WASAPI system loopback on Windows, and the sound follows
 * Video mode unless the teacher overrides it with the Sound button.
 */

/** 'auto' = send while Video mode is on (or when ticked at share start). */
export type ShareAudioChoice = 'auto' | 'on' | 'off';

/**
 * Echo (round 5): whole-device loopback also records the students' voices
 * this app is playing, so every student heard themselves ~0.5 s later. Share
 * audio now follows Video mode automatically ONLY when the capture leaves out
 * this app's own output (sidecar WASAPI process loopback, exclude mode). The
 * Electron fallback (whole-device loopback) is sent only on an explicit choice.
 */
export function wantShareAudio(input: { choice: ShareAudioChoice; videoMode: boolean; askedAtStart: boolean; excludesOwnOutput: boolean }): boolean {
  if (input.choice === 'off') return false;
  if (input.choice === 'on') return true;
  if (input.askedAtStart) return true;
  return input.excludesOwnOutput && input.videoMode;
}

export const SHARE_AUDIO_ECHO_WARNING =
  "Computer sound is on. This PC sends everything it plays, including your students' voices: use headphones, or students hear an echo.";

/** The Sound button flips what is happening now into an explicit choice. */
export function toggleShareAudio(sendingNow: boolean): ShareAudioChoice {
  return sendingNow ? 'off' : 'on';
}

/**
 * getUserMedia constraints for Windows system loopback audio. Chromium needs a
 * desktop video track alongside it; the caller stops that track immediately,
 * so it is kept tiny.
 */
export function desktopLoopbackConstraints(): MediaStreamConstraints {
  return {
    audio: { mandatory: { chromeMediaSource: 'desktop' } },
    video: { mandatory: { chromeMediaSource: 'desktop', maxWidth: 160, maxHeight: 90, maxFrameRate: 1 } },
  } as unknown as MediaStreamConstraints;
}

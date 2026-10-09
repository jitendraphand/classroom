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

export function wantShareAudio(input: { choice: ShareAudioChoice; videoMode: boolean; askedAtStart: boolean }): boolean {
  if (input.choice === 'off') return false;
  if (input.choice === 'on') return true;
  return input.videoMode || input.askedAtStart;
}

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

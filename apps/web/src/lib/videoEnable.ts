/**
 * Turning a remote video off at the SFU without taking over from
 * adaptiveStream for good.
 *
 * livekit-client (2.22) keeps a `requestedDisabled` flag on every remote
 * publication. `setEnabled(false)` sets it; `setEnabled(true)` sets it to
 * false, and from then on the SDK ignores adaptiveStream's visibility (an
 * element that is not shown, such as the share under the whiteboard, would
 * keep receiving). To "stop overriding", the flag has to go back to
 * undefined and the track settings be re-sent. Pure so it is unit-tested
 * against a fake publication.
 */
export type EnablablePublication = {
  readonly isEnabled: boolean;
  setEnabled(enabled: boolean): void;
};

type SdkInternals = { requestedDisabled?: boolean; emitTrackUpdate?: () => void };

export function setVideoWanted(pub: EnablablePublication, want: boolean): void {
  if (!want) {
    pub.setEnabled(false);
    return;
  }
  const p = pub as unknown as SdkInternals;
  if ('requestedDisabled' in p && typeof p.emitTrackUpdate === 'function') {
    if (p.requestedDisabled !== true) return; // not disabled by us: adaptiveStream decides
    p.requestedDisabled = undefined;
    p.emitTrackUpdate();
    return;
  }
  // SDK internals changed: fall back to the public API (video always on).
  if (!pub.isEnabled) pub.setEnabled(true);
}

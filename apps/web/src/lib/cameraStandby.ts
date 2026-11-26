/**
 * Camera standby (student): the camera device is closed while nothing needs
 * it, so a phone does not keep the sensor, ISP and preview pipeline running
 * (battery, heat) for video nobody sees. The camera stays "on" for the class:
 * the student's choice is kept, the teacher can still unmute them (unmute
 * needs the camera on) and they stay on the video pages; the device reopens
 * as soon as something needs it.
 *
 * Something needs it when the server wants this student's video (their page
 * in the teacher's video panel, speaking, spotlighted, an admin observer:
 * `me.camWanted`) or the student's own self-view is on screen.
 *
 * Pure, unit-tested (tests/videoImprovements.test.ts).
 */

/** After nothing needs the camera, wait this long before closing it (page flips, mode taps). */
export const CAMERA_STANDBY_GRACE_MS = 10_000;

export function cameraDeviceNeeded(opts: { camOn: boolean; serverWantsVideo: boolean; selfPreviewShown: boolean }): boolean {
  return opts.camOn && (opts.serverWantsVideo || opts.selfPreviewShown);
}

/**
 * What the student reports to the server as "camera on": a live camera, or a
 * camera in standby that already worked in this class (so a device that was
 * never opened, or failed, is not reported as on).
 */
export function cameraReportedOn(opts: { camOn: boolean; live: boolean; standby: boolean; workedBefore: boolean }): boolean {
  return opts.camOn && (opts.live || (opts.standby && opts.workedBefore));
}

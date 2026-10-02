/**
 * Camera / screen-share capture and encoding settings, in one place.
 * Plain data (no livekit-client import) so it is unit-tested and shared.
 *
 * Teacher camera: 720p with simulcast (180p + 360p + 720p). Students and the
 * admin tiles subscribe with adaptiveStream, so the SFU forwards the layer that
 * fits the element showing it; with dynacast the teacher's browser stops
 * encoding layers nobody is receiving.
 *
 * Student camera: small single layer. Only the teacher ever receives student
 * video (at most 6 in the 2/4/6 mosaic), and simulcast would cost weak student
 * devices an extra encoder for no viewer benefit.
 *
 * Screen share: unchanged (≤1080p, single layer, 15 fps) — text needs the full
 * resolution and every student shows it full screen.
 */

export type Layer = { width: number; height: number; maxBitrate: number; maxFramerate: number };

export const TEACHER_CAMERA = {
  /** getUserMedia constraints (ideal; the browser picks the closest mode). */
  capture: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  /** Top layer (the captured 720p). */
  encoding: { maxBitrate: 1_500_000, maxFramerate: 30 },
  simulcast: true,
  /** Lower simulcast layers, smallest first. */
  layers: [
    { width: 320, height: 180, maxBitrate: 140_000, maxFramerate: 15 },
    { width: 640, height: 360, maxBitrate: 500_000, maxFramerate: 24 },
  ] satisfies Layer[],
} as const;

export const STUDENT_CAMERA = {
  capture: { width: { ideal: 320 }, height: { ideal: 180 }, frameRate: { ideal: 15 } },
  encoding: { maxBitrate: 200_000, maxFramerate: 15 },
  simulcast: false,
} as const;

export const SCREEN_SHARE = {
  capture: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 15, max: 30 } },
  encoding: { maxBitrate: 1_500_000, maxFramerate: 15 },
  simulcast: false,
} as const;

export function cameraProfile(isTeacher: boolean) {
  return isTeacher ? TEACHER_CAMERA : STUDENT_CAMERA;
}

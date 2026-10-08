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
 * Screen share: ≤1080p top layer (unchanged) plus a 720p low layer for small
 * viewports and admin tiles, when the capture is big enough (see
 * screenShareSimulcastFor). Firefox publishers never simulcast a screen share
 * (livekit-client disables it there); they keep the single 1080p layer.
 */

export type Layer = { width: number; height: number; maxBitrate: number; maxFramerate: number };

export const TEACHER_CAMERA = {
  /** getUserMedia constraints (ideal; the browser picks the closest mode). */
  capture: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
  /** Top layer (the captured 720p). */
  // 24 fps / 1.2 Mbps: a talking head looks the same as 30 fps / 1.5 Mbps and
  // costs the teacher's laptop ~20% less encode CPU and uplink.
  encoding: { maxBitrate: 1_200_000, maxFramerate: 24 },
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
  // max 15: the encoder never sends more than 15 fps, so capturing (and masking)
  // up to 30 only burned CPU. Static slides deliver far fewer frames anyway.
  capture: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 15, max: 15 } },
  /** Top layer: the captured resolution (≤1080p with the capture hints). */
  encoding: { maxBitrate: 1_500_000, maxFramerate: 15 },
  simulcast: true,
  /**
   * One lower layer, 720p @ 10 fps ≤500 kbps. 720p (a 1.5× downscale of 1080p)
   * keeps normal slide text (≈18 pt and up) readable; 540p would be a 2× scale
   * and blur small text, code and spreadsheet cells. Slides are mostly static,
   * so 10 fps leaves more bits per frame for sharp text; the cost is a less
   * smooth pointer. Received by small viewports (phones, small windows) and
   * the admin tiles; large viewports keep the top layer.
   */
  layers: [{ width: 1280, height: 720, maxBitrate: 500_000, maxFramerate: 10 }] satisfies Layer[],
} as const;

/**
 * Simulcast a screen share only when the capture is clearly bigger than the
 * low layer: otherwise both layers would be about the same size and the
 * teacher would encode the screen twice for nothing (small window shares,
 * Safari captures without size hints that come out small). Unknown size →
 * single layer. Compares the shorter side, as LiveKit scales layers by it.
 */
export function screenShareSimulcastFor(width: number | undefined, height: number | undefined): boolean {
  if (!width || !height) return false;
  const low = SCREEN_SHARE.layers[0];
  return Math.min(width, height) >= Math.min(low.width, low.height) * 1.25;
}

/**
 * Video mode (teacher's "Video" toggle in the share controls): the share is a
 * playing video, not slides. Motion beats sharpness here, so:
 * - capture at 30 fps (slides capture at 15) and hint the encoder `motion`;
 * - top layer ≤1080p @ 30 fps / 2.5 Mbps, low layer 720p @ 30 fps / 1 Mbps
 *   (slides: 15 fps / 1.5 Mbps and 10 fps / 0.5 Mbps);
 * - under CPU/bandwidth pressure keep the frame rate and drop resolution
 *   (`maintain-framerate`), the opposite of slides.
 * Phones and small windows receive the 720p30 layer (≈1 Mbps); large
 * viewports the top layer. Share audio is published as before (music preset).
 */
export const SCREEN_SHARE_VIDEO_MODE = {
  capture: { frameRate: { ideal: 30, max: 30 } },
  top: { maxBitrate: 2_500_000, maxFramerate: 30 },
  low: { maxBitrate: 1_000_000, maxFramerate: 30 },
  degradationPreference: 'maintain-framerate',
  contentHint: 'motion',
} as const;

export type ShareProfile = {
  capture: { frameRate: { ideal: number; max: number } };
  top: { maxBitrate: number; maxFramerate: number };
  low: { maxBitrate: number; maxFramerate: number };
  degradationPreference: 'maintain-framerate' | 'maintain-resolution';
  contentHint: 'motion' | 'detail';
};

/** Capture / encoder settings for a share: slides (default) or video mode. */
export function shareProfile(videoMode: boolean): ShareProfile {
  if (videoMode) return SCREEN_SHARE_VIDEO_MODE;
  const low = SCREEN_SHARE.layers[0];
  return {
    capture: { frameRate: { ideal: SCREEN_SHARE.capture.frameRate.ideal, max: SCREEN_SHARE.capture.frameRate.max } },
    top: { maxBitrate: SCREEN_SHARE.encoding.maxBitrate, maxFramerate: SCREEN_SHARE.encoding.maxFramerate },
    low: { maxBitrate: low.maxBitrate, maxFramerate: low.maxFramerate },
    degradationPreference: 'maintain-resolution',
    contentHint: 'detail',
  };
}

/**
 * New RTCRtpSender encodings for a share profile. Simulcast encodings are
 * ordered low → high, so the last one is the top layer; a single encoding is
 * the top layer. Everything else on each encoding (rid, active, scale) is kept.
 */
export function shareEncodingsFor<E extends { maxBitrate?: number; maxFramerate?: number }>(
  encodings: E[],
  videoMode: boolean
): E[] {
  const p = shareProfile(videoMode);
  return encodings.map((e, i) => {
    const layer = i === encodings.length - 1 ? p.top : p.low;
    return { ...e, maxBitrate: layer.maxBitrate, maxFramerate: layer.maxFramerate };
  });
}

export function cameraProfile(isTeacher: boolean) {
  return isTeacher ? TEACHER_CAMERA : STUDENT_CAMERA;
}

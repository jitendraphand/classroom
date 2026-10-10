/**
 * Camera / screen-share capture and encoding settings, in one place.
 * Plain data (no livekit-client import) so it is unit-tested and shared.
 *
 * Teacher camera: 360p single layer. Student camera: small single layer, and
 * only published while the teacher actually shows it (see camWanted in /state).
 * Screen share: VP9 L1T3 (frame rate degrades, resolution never) with a VP8
 * 720p-floor simulcast backup; slides ≤8 fps, video mode 720p24. Subscribers
 * use adaptiveStream + dynacast (ClassroomRoom), so the SFU forwards what fits
 * the element and publishers stop encoding layers nobody receives.
 */

export type Layer = { width: number; height: number; maxBitrate: number; maxFramerate: number };

/**
 * Teacher camera: 360p, one layer (2026-10). Students see it in a small
 * floating tile (or not at all when they minimise it or pick "Audio + share
 * only"), and the admin tiles are smaller still, so 720p simulcast cost the
 * teacher's uplink ~1.8 Mbps for pixels nobody displayed. 360p @ 15 fps
 * ≤300 kbps looks the same in that tile (measured ~190 kbps).
 */
export const TEACHER_CAMERA = {
  capture: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 15 } },
  encoding: { maxBitrate: 300_000, maxFramerate: 15 },
  simulcast: false,
  layers: [] as Layer[],
} as const;

export const STUDENT_CAMERA = {
  capture: { width: { ideal: 320 }, height: { ideal: 180 }, frameRate: { ideal: 15 } },
  encoding: { maxBitrate: 200_000, maxFramerate: 15 },
  simulcast: false,
} as const;

export const SCREEN_SHARE = {
  // Slides: max 8 fps. Chrome's screen capturer only delivers a frame when the
  // screen changes, and the encoder sends almost nothing for a static frame,
  // so a still slide costs ~0 kbps; 8 fps keeps the pointer readable.
  capture: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 8, max: 8 } },
  /** Top layer: the captured resolution (≤1080p with the capture hints). */
  encoding: { maxBitrate: 1_500_000, maxFramerate: 8 },
  simulcast: true,
  /**
   * VP8/H.264 fallback only (VP9 uses one spatial layer, see SHARE_CODEC):
   * one lower layer at 720p, the floor for legible slide text (540p blurs
   * small text). Received by small viewports, data-saver students and admin
   * tiles; large viewports keep the top layer.
   */
  layers: [{ width: 1280, height: 720, maxBitrate: 500_000, maxFramerate: 8 }] satisfies Layer[],
} as const;

/**
 * Screen-share codec. Chromium publishers send VP9 with ONE spatial layer and
 * three temporal layers (L1T3): the SFU can drop to 1/2 or 1/4 of the frame
 * rate for a slow subscriber but never lowers the resolution (720p+ floor),
 * and VP9 needs ~30-40% fewer bits than VP8 for screen text. Subscribers that
 * cannot decode VP9 (older iOS Safari) get the VP8 backup codec, which the
 * publisher starts on demand (LiveKit backupCodec) with the 720p simulcast
 * layer above. Other publishers (Safari, Firefox) keep VP8 simulcast.
 */
export const SHARE_CODEC = {
  codec: 'vp9',
  scalabilityMode: 'L1T3',
  backupCodec: 'vp8',
} as const;

/** VP9 SVC publishing is reliable in Chromium only. */
export function shareUsesVp9(ua: string): boolean {
  if (!ua) return false;
  if (/Firefox\//.test(ua) || /FxiOS|CriOS|EdgiOS/.test(ua)) return false;
  // Safari (incl. every iOS browser) has no Chrome/ token or is iOS WebKit.
  if (/iPhone|iPad|iPod/.test(ua)) return false;
  return /Chrome\/|Chromium\/|Edg\//.test(ua);
}

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
 * Video mode (teacher's "Video" toggle in the share controls, manual only):
 * the share is a playing video. Capped at 720p and 24 fps (capture
 * constraints), contentHint `motion`, ≤1.5 Mbps. Resolution is still kept
 * under pressure (frame rate drops first) so text in the video stays legible.
 * Share audio is published as before (music preset).
 */
export const SCREEN_SHARE_VIDEO_MODE = {
  capture: { frameRate: { ideal: 24, max: 24 }, height: { max: 720 }, width: { max: 1280 } },
  top: { maxBitrate: 1_500_000, maxFramerate: 24 },
  low: { maxBitrate: 1_000_000, maxFramerate: 24 },
  degradationPreference: 'maintain-resolution',
  contentHint: 'motion',
} as const;

export type ShareProfile = {
  capture: { frameRate: { ideal: number; max: number }; height?: { ideal?: number; max?: number }; width?: { ideal?: number; max?: number } };
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
    capture: {
      frameRate: { ideal: SCREEN_SHARE.capture.frameRate.ideal, max: SCREEN_SHARE.capture.frameRate.max },
      width: { ideal: SCREEN_SHARE.capture.width.ideal },
      height: { ideal: SCREEN_SHARE.capture.height.ideal },
    },
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

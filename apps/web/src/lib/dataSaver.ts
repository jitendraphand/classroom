/**
 * Student data saver (student controls, same button on every device):
 * - 'off': normal (adaptiveStream picks the layer that fits the element).
 * - 'low': low layers: screen share capped at its LOW quality (VP9: lowest
 *   temporal layer → fewer fps, same resolution; VP8 backup: the 720p layer),
 *   teacher camera LOW.
 * - 'share-only': audio + screen share only; the teacher camera is disabled
 *   at the SFU (no camera bytes at all).
 * - 'audio-only': audio (and the whiteboard, which is data only); the
 *   teacher camera and the screen share are both disabled at the SFU. For
 *   2G/3G links and nearly used-up data packs, where the share is the
 *   largest stream.
 * Also: a minimized floating teacher video pauses the teacher camera, and a
 * page hidden for BACKGROUND_VIDEO_PAUSE_MS pauses all teacher video until
 * the student is back (audio keeps playing).
 */
export type DataSaverMode = 'off' | 'low' | 'share-only' | 'audio-only';

/**
 * A student page hidden this long (another app, minimised browser, locked
 * screen) stops receiving teacher video; audio continues. Short switches
 * (checking a message) keep the video so returning never shows a stall.
 */
export const BACKGROUND_VIDEO_PAUSE_MS = 20_000;

export const DATA_SAVER_KEY = 'classroom.dataSaver';

export function parseDataSaver(v: unknown): DataSaverMode {
  return v === 'low' || v === 'share-only' || v === 'audio-only' ? v : 'off';
}

export function nextDataSaver(m: DataSaverMode): DataSaverMode {
  return m === 'off' ? 'low' : m === 'low' ? 'share-only' : m === 'share-only' ? 'audio-only' : 'off';
}

export function dataSaverLabel(m: DataSaverMode): string {
  if (m === 'low') return 'Data saver: Low quality (tap for Audio + share only)';
  if (m === 'share-only') return 'Data saver: Audio + screen share only (tap for Audio only)';
  if (m === 'audio-only') return 'Data saver: Audio only, no video (tap for normal quality)';
  return 'Data saver off (tap for Low quality)';
}

/** Word on the quality button (its caption reads "Quality"). */
export function dataSaverBadge(m: DataSaverMode): string {
  return m === 'low' ? 'Low' : m === 'share-only' ? 'Share' : m === 'audio-only' ? 'Audio' : 'Full';
}

/** The teacher camera is not received at all in this mode. */
export function teacherCameraOff(m: DataSaverMode): boolean {
  return m === 'share-only' || m === 'audio-only';
}

/**
 * What a student receives of the teacher's video tracks. `backgroundPaused`:
 * the page has been hidden for BACKGROUND_VIDEO_PAUSE_MS.
 */
export function teacherVideoDemand(opts: { mode: DataSaverMode; camPaneMinimized: boolean; backgroundPaused?: boolean }): {
  cameraEnabled: boolean;
  cameraLow: boolean;
  shareEnabled: boolean;
  shareLow: boolean;
} {
  const paused = !!opts.backgroundPaused;
  return {
    cameraEnabled: !opts.camPaneMinimized && !teacherCameraOff(opts.mode) && !paused,
    cameraLow: opts.mode !== 'off',
    shareEnabled: opts.mode !== 'audio-only' && !paused,
    shareLow: opts.mode !== 'off',
  };
}

/**
 * Starting mode for a device with no saved choice. The deployment's media
 * profile sets the floor ('low' starts in Low quality); the browser's
 * Network Information hints lower it further: Save-Data or a 2G link starts
 * in Audio only, a 3G link in Low quality. Browsers without the API (Safari,
 * Firefox) keep the profile's mode. The student can always change it.
 */
export function initialDataSaver(
  profile: 'standard' | 'low',
  conn?: { saveData?: boolean; effectiveType?: string } | null,
): DataSaverMode {
  const t = conn?.effectiveType;
  if (conn?.saveData || t === 'slow-2g' || t === '2g') return 'audio-only';
  if (t === '3g' || profile === 'low') return 'low';
  return 'off';
}

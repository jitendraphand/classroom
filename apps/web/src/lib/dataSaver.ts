/**
 * Student data saver (student controls, same button on every device):
 * - 'off': normal (adaptiveStream picks the layer that fits the element).
 * - 'low': low layers: screen share capped at its LOW quality (VP9: lowest
 *   temporal layer → fewer fps, same resolution; VP8 backup: the 720p layer),
 *   teacher camera LOW.
 * - 'share-only': audio + screen share only; the teacher camera is disabled
 *   at the SFU (no camera bytes at all).
 * Also: a minimized floating teacher video pauses the teacher camera.
 */
export type DataSaverMode = 'off' | 'low' | 'share-only';

export const DATA_SAVER_KEY = 'classroom.dataSaver';

export function parseDataSaver(v: unknown): DataSaverMode {
  return v === 'low' || v === 'share-only' ? v : 'off';
}

export function nextDataSaver(m: DataSaverMode): DataSaverMode {
  return m === 'off' ? 'low' : m === 'low' ? 'share-only' : 'off';
}

export function dataSaverLabel(m: DataSaverMode): string {
  if (m === 'low') return 'Data saver: Low quality (tap for Audio + share only)';
  if (m === 'share-only') return 'Data saver: Audio + share only (tap for normal quality)';
  return 'Data saver off (tap for Low quality)';
}

export function dataSaverBadge(m: DataSaverMode): string {
  return m === 'low' ? 'LQ' : m === 'share-only' ? 'A+S' : 'HD';
}

/** What a student subscribes to for the teacher's video tracks. */
export function teacherVideoDemand(opts: { mode: DataSaverMode; camPaneMinimized: boolean }): {
  cameraEnabled: boolean;
  cameraLow: boolean;
  shareLow: boolean;
} {
  return {
    cameraEnabled: !opts.camPaneMinimized && opts.mode !== 'share-only',
    cameraLow: opts.mode !== 'off',
    shareLow: opts.mode !== 'off',
  };
}

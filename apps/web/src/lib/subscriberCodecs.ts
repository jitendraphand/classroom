/**
 * Student (subscriber) decode choices (pure, shared).
 *
 * The teacher's share is VP9 (one 1080p spatial layer) with an H.264 backup
 * that is simulcast (1080p + 720p). A subscriber that leaves VP9 out of its
 * answer receives the backup codec from LiveKit. So:
 * - phones / small screens decline VP9: they get H.264 (hardware decoded on
 *   every phone) and adaptive stream picks the 720p layer for their CSS size;
 * - other devices decline VP9 when it is not power-efficient (no hardware
 *   decoder) while H.264 is, e.g. older iPhones/Macs.
 */

export type ScreenInfo = { coarse: boolean; screenW: number; screenH: number };

/** Phone-sized touch screen: count CSS pixels 1:1 and take the 720p layer. */
export function isSmallScreen(s: ScreenInfo): boolean {
  return s.coarse && Math.min(s.screenW || 0, s.screenH || 0) < 600;
}

export function shouldDeclineVp9(opts: {
  small: boolean;
  vp9Efficient: boolean | null;
  h264Efficient: boolean | null;
  h264Supported: boolean | null;
}): boolean {
  if (opts.h264Supported === false) return false;
  if (opts.small) return true;
  return opts.vp9Efficient === false && opts.h264Efficient === true;
}

type Codec = { mimeType: string; sdpFmtpLine?: string };

/** Codec preference list without VP9/AV1 (rtx/red/ulpfec kept). Never returns an empty list. */
export function withoutVp9<T extends Codec>(codecs: readonly T[]): T[] {
  const out = codecs.filter((c) => !/video\/(vp9|av1)$/i.test(c.mimeType));
  return out.some((c) => /video\/(h264|vp8)$/i.test(c.mimeType)) ? out : codecs.slice();
}

/** Which share layer a viewer should ask for (720p floor for small screens). */
export function shareLayerFor(s: ScreenInfo, dataSaverLow: boolean): 'low' | 'high' {
  return dataSaverLow || isSmallScreen(s) ? 'low' : 'high';
}

/** What a small screen asks the SFU for: the 720p share layer. */
export const SMALL_SCREEN_SHARE_DIMENSIONS = { width: 1280, height: 720 } as const;

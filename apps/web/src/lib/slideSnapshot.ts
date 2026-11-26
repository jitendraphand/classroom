/**
 * Slide snapshots for students in "Audio only" data-saver mode.
 *
 * The live screen share is the largest stream a student receives
 * (~135–200 MB/h on a phone). A student in Audio only receives none of it;
 * instead the teacher's browser takes a still picture of the share when it
 * changes (checked every few seconds, sent at most every MIN_UPLOAD_GAP_MS),
 * the server keeps only the latest one, and audio-only students download it
 * as an ordinary image (tens of KB) when told a new one exists. A slide
 * lesson then costs ~10–20 MB/h instead of the live share (estimate: one
 * ~60 KB picture per slide change).
 *
 * Pure helpers (validation, change detection, sizing), unit-tested in
 * tests/videoImprovements.test.ts.
 */

/** LiveKit data topic for "a new snapshot exists" (server-originated). */
export const SNAPSHOT_TOPIC = 'cls-snap';

/** Teacher checks the share for changes this often. */
export const SNAPSHOT_CHECK_MS = 4_000;
/** ...and sends a changed picture at most this often. */
export const MIN_UPLOAD_GAP_MS = 10_000;
/** Server: refuse uploads closer together than this (per room). */
export const SERVER_MIN_GAP_S = 4;
/** Longest side of the picture (720p-class: slide text stays legible on phones). */
export const SNAPSHOT_MAX_SIDE = 1280;
/** Decoded picture size cap (a 1280-px WebP/JPEG slide is ~30–150 KB). */
export const SNAPSHOT_MAX_BYTES = 350_000;
/** Snapshot kept this long (a class never runs longer). */
export const SNAPSHOT_TTL_S = 6 * 60 * 60;
/** Students spread their download over this window after a push (no stampede). */
export const SNAPSHOT_FETCH_SPREAD_MS = 4_000;
/** Safety poll while a student is in Audio only (missed push). */
export const SNAPSHOT_SAFETY_POLL_MS = 60_000;

export type SnapshotType = 'image/webp' | 'image/jpeg';

export type SnapshotPacket = { v: 1; ver: number };

export function decodeSnapshotPacket(raw: unknown): SnapshotPacket | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || typeof o.ver !== 'number' || !Number.isFinite(o.ver) || o.ver < 0) return null;
  return { v: 1, ver: o.ver };
}

/** True when the bytes really are the declared image type (magic numbers). */
export function snapshotBytesValid(bytes: Uint8Array, type: SnapshotType): boolean {
  if (bytes.length < 12 || bytes.length > SNAPSHOT_MAX_BYTES) return false;
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
}

/** Scale (w, h) so the longest side is at most `max`, keeping the aspect ratio. */
export function snapshotSize(w: number, h: number, max = SNAPSHOT_MAX_SIDE): { w: number; h: number } {
  if (!(w > 0) || !(h > 0)) return { w: 0, h: 0 };
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/**
 * Did the picture change since the last one sent? `a` and `b` are 64×36
 * grayscale thumbnails (one byte per pixel); the score is the mean absolute
 * difference (0–255). Measured in Chromium on a 1920×1080 track: same slide
 * 0, a pointer-sized change 0.01, a new slide ~100. Writing on a slide adds
 * up against the last picture sent until it crosses the threshold.
 */
export function thumbnailChanged(a: Uint8Array | null, b: Uint8Array, threshold = 1): boolean {
  if (!a || a.length !== b.length || !b.length) return true;
  let sum = 0;
  for (let i = 0; i < b.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / b.length > threshold;
}

/** Should the teacher send this check's picture? */
export function shouldUpload(opts: { changed: boolean; now: number; lastUploadAt: number; pendingChange: boolean }): boolean {
  if (!opts.changed && !opts.pendingChange) return false;
  return opts.now - opts.lastUploadAt >= MIN_UPLOAD_GAP_MS;
}

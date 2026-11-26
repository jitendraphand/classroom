'use client';

import { useEffect } from 'react';
import { Track, type Room } from 'livekit-client';
import { roomFetch } from '@/lib/classroomClient';
import {
  SNAPSHOT_CHECK_MS,
  SNAPSHOT_MAX_BYTES,
  shouldUpload,
  snapshotSize,
  thumbnailChanged,
  type SnapshotType,
} from '@/lib/slideSnapshot';

const THUMB_W = 64;
const THUMB_H = 36;

type FrameSource = {
  /** Draw the current frame into `ctx` at (w, h); false when no frame is ready. */
  draw(ctx: CanvasRenderingContext2D, w: number, h: number): Promise<boolean>;
  size(): { w: number; h: number };
  close(): void;
};

type ImageCaptureLike = { grabFrame(): Promise<ImageBitmap> };

/** Frames from the published share track: ImageCapture where available, else a muted <video>. */
function frameSource(track: MediaStreamTrack): FrameSource {
  const IC = (globalThis as unknown as { ImageCapture?: new (t: MediaStreamTrack) => ImageCaptureLike }).ImageCapture;
  if (IC) {
    const cap = new IC(track);
    let last = { w: 0, h: 0 };
    return {
      async draw(ctx, w, h) {
        try {
          const bmp = await cap.grabFrame();
          last = { w: bmp.width, h: bmp.height };
          ctx.drawImage(bmp, 0, 0, w, h);
          bmp.close();
          return true;
        } catch {
          return false;
        }
      },
      size() {
        const s = track.getSettings();
        return { w: s.width || last.w, h: s.height || last.h };
      },
      close() {},
    };
  }
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  void video.play().catch(() => undefined);
  return {
    async draw(ctx, w, h) {
      if (video.readyState < 2 || !video.videoWidth) return false;
      ctx.drawImage(video, 0, 0, w, h);
      return true;
    },
    size: () => ({ w: video.videoWidth, h: video.videoHeight }),
    close() {
      video.srcObject = null;
    },
  };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}

/**
 * Smallest of WebP and JPEG (measured at 1280×720: a text slide is ~66 KiB as
 * WebP vs ~98 KiB as JPEG, a photo-like screen ~177 KiB WebP vs ~125 KiB JPEG).
 * Safari returns PNG for an unknown type, so the returned blob type is checked.
 * Still too big: JPEG at a lower quality.
 */
async function encode(canvas: HTMLCanvasElement): Promise<{ blob: Blob; type: SnapshotType } | null> {
  let best: { blob: Blob; type: SnapshotType } | null = null;
  for (const [type, q] of [['image/webp', 0.6], ['image/jpeg', 0.62]] as const) {
    const blob = await toBlob(canvas, type, q);
    if (blob && blob.type === type && (!best || blob.size < best.blob.size)) best = { blob, type };
  }
  if (best && best.blob.size <= SNAPSHOT_MAX_BYTES * 0.7) return best;
  const small = await toBlob(canvas, 'image/jpeg', 0.45);
  if (small && small.type === 'image/jpeg' && small.size <= SNAPSHOT_MAX_BYTES) return { blob: small, type: 'image/jpeg' };
  return best && best.blob.size <= SNAPSHOT_MAX_BYTES ? best : null;
}

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Teacher (web): while the screen is shared, keep the server's slide snapshot
 * (lib/slideSnapshot) up to date for students in "Audio only". Checks the
 * published share every SNAPSHOT_CHECK_MS on a 64×36 grayscale thumbnail and
 * uploads a ≤1280-px picture only when it changed (at most every
 * MIN_UPLOAD_GAP_MS). A still slide therefore costs nothing after the first
 * picture. The snapshot is dropped when the share stops.
 */
export function useShareSnapshots({ room, code, active }: { room: Room | undefined; code: string; active: boolean }) {
  useEffect(() => {
    if (!room || !active || typeof document === 'undefined') return;
    let stopped = false;
    let source: FrameSource | null = null;
    let sourceTrack: MediaStreamTrack | null = null;
    // Thumbnail of the last picture SENT: slow changes (writing on a slide) add
    // up until they cross the threshold, instead of each check looking small.
    let sentThumb: Uint8Array | null = null;
    let lastUploadAt = 0;
    let pendingChange = false;
    let busy = false;
    const thumb = document.createElement('canvas');
    thumb.width = THUMB_W;
    thumb.height = THUMB_H;
    const tctx = thumb.getContext('2d', { willReadFrequently: true });
    const full = document.createElement('canvas');
    const fctx = full.getContext('2d');

    const check = async () => {
      if (stopped || busy || !tctx || !fctx) return;
      const track = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track?.mediaStreamTrack;
      if (!track || track.readyState !== 'live') return;
      busy = true;
      try {
        if (track !== sourceTrack) {
          source?.close();
          source = frameSource(track);
          sourceTrack = track;
          sentThumb = null;
        }
        if (!(await source!.draw(tctx, THUMB_W, THUMB_H))) return;
        const data = tctx.getImageData(0, 0, THUMB_W, THUMB_H).data;
        const gray = new Uint8Array(THUMB_W * THUMB_H);
        for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = (data[i]! * 3 + data[i + 1]! * 6 + data[i + 2]!) / 10;
        const changed = thumbnailChanged(sentThumb, gray);
        const now = Date.now();
        if (!shouldUpload({ changed, now, lastUploadAt, pendingChange })) {
          if (changed) pendingChange = true; // send it once the gap has passed
          return;
        }
        const { w, h } = snapshotSize(source!.size().w, source!.size().h);
        if (!w || !h) return;
        full.width = w;
        full.height = h;
        if (!(await source!.draw(fctx, w, h))) return;
        const enc = await encode(full);
        if (!enc || stopped) return;
        const res = await roomFetch(code, '/snapshot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: await base64(enc.blob), type: enc.type }),
        });
        if (res.ok) {
          lastUploadAt = now;
          pendingChange = false;
          sentThumb = gray;
        }
      } catch (e) {
        console.warn('slide snapshot', e);
      } finally {
        busy = false;
      }
    };

    const iv = window.setInterval(() => void check(), SNAPSHOT_CHECK_MS);
    const first = window.setTimeout(() => void check(), 1500);
    return () => {
      stopped = true;
      window.clearInterval(iv);
      window.clearTimeout(first);
      source?.close();
      // Share stopped (or the class page closed): no stale picture for anyone.
      void roomFetch(code, '/snapshot', { method: 'DELETE', keepalive: true }).catch(() => undefined);
    };
  }, [room, code, active]);
}

/**
 * Freeze-frame annotation for an entire-screen share.
 *
 * A monitor capture cannot be previewed on the teacher's own stage (it would
 * record the stage itself: an endless tunnel), so there is nothing live to
 * draw on. Instead, when the teacher turns Annotate on, the current frame of
 * the published share is copied to a canvas and the published track is
 * swapped (RTCRtpSender.replaceTrack) for that still picture. The teacher draws
 * on the same still in the classroom tab; students see the still with the
 * strokes on top (strokes are normalised to the frame, so they line up).
 * Turning Annotate off swaps the live capture back in.
 */

/** Pure: should the published share be frozen right now? */
export function shouldFreezeShare(opts: { annotateOn: boolean; screenOn: boolean; surface: string; previewable: boolean }) {
  return opts.annotateOn && opts.screenOn && !!opts.surface && !opts.previewable;
}

/** Pure: canvas size for the still (the frame size, capped to keep encode cheap). */
export function stillSize(w: number, h: number, maxLong = 1920): { width: number; height: number } {
  if (!w || !h) return { width: 0, height: 0 };
  const long = Math.max(w, h);
  const scale = long > maxLong ? maxLong / long : 1;
  return { width: Math.max(2, Math.round((w * scale) / 2) * 2), height: Math.max(2, Math.round((h * scale) / 2) * 2) };
}

export function freezeSupported(): boolean {
  return typeof document !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' &&
    typeof (HTMLCanvasElement.prototype as { captureStream?: unknown }).captureStream === 'function';
}

type ImageCaptureCtor = new (track: MediaStreamTrack) => { grabFrame(): Promise<ImageBitmap> };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

/** Copy the current frame of a video track onto a new canvas. */
export async function snapshotTrack(
  track: MediaStreamTrack,
  opts: { imageCaptureOnly?: boolean } = {}
): Promise<HTMLCanvasElement | null> {
  if (track.readyState !== 'live') return null;
  const draw = (src: CanvasImageSource, w: number, h: number) => {
    const size = stillSize(w, h);
    if (!size.width) return null;
    const c = document.createElement('canvas');
    c.width = size.width;
    c.height = size.height;
    const ctx = c.getContext('2d', { alpha: false });
    if (!ctx) return null;
    ctx.drawImage(src, 0, 0, size.width, size.height);
    return c;
  };
  // Chrome / Edge: ImageCapture.grabFrame (a static screen may not produce a
  // new frame soon, hence the timeout and the <video> fallback).
  const IC = (globalThis as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture;
  if (IC) {
    try {
      const bmp = await withTimeout(new IC(track).grabFrame(), 1200);
      if (bmp) {
        const c = draw(bmp, bmp.width, bmp.height);
        bmp.close();
        if (c) return c;
      }
    } catch {
      /* fall through */
    }
  }
  if (opts.imageCaptureOnly) return null;
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.srcObject = new MediaStream([track]);
  try {
    await withTimeout(v.play(), 1500);
    await withTimeout(
      new Promise<void>((resolve) => {
        if (v.readyState >= 2 && v.videoWidth) resolve();
        else v.addEventListener('loadeddata', () => resolve(), { once: true });
      }),
      2000
    );
    return draw(v, v.videoWidth, v.videoHeight);
  } catch {
    return null;
  } finally {
    v.pause();
    v.srcObject = null;
  }
}

export type FrozenStill = { track: MediaStreamTrack; stop: () => void };

/**
 * A video track that keeps showing `canvas`. A canvas track only emits a frame
 * when asked, so it is re-sent twice a second: a student who joins (or a
 * simulcast layer that switches) during the freeze still gets a picture.
 */
export function stillTrack(canvas: HTMLCanvasElement): FrozenStill | null {
  const cap = (canvas as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream }).captureStream;
  if (!cap) return null;
  const stream = cap.call(canvas, 0);
  const track = stream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
  if (!track) return null;
  try {
    track.contentHint = 'detail';
  } catch {
    /* ignore */
  }
  const ctx = canvas.getContext('2d');
  const repaint = () => {
    // Touch the canvas so browsers without requestFrame still emit a frame.
    if (ctx) {
      const px = ctx.getImageData(0, 0, 1, 1);
      ctx.putImageData(px, 0, 0);
    }
    track.requestFrame?.();
  };
  repaint();
  const timer = setInterval(repaint, 500);
  return {
    track,
    stop: () => {
      clearInterval(timer);
      try {
        track.stop();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * While the classroom tab is hidden during an entire-screen share, keep a
 * still of the screen about once a second (ImageCapture only, so Chrome/Edge).
 * When the teacher then comes back to the tab and turns Annotate on, the live
 * capture already shows the classroom tab itself; the last still taken while
 * the tab was hidden is the screen they actually meant to draw on.
 */
export function startBackgroundStills(getTrack: () => MediaStreamTrack | null, everyMs = 1000) {
  let latest: HTMLCanvasElement | null = null;
  let busy = false;
  const tick = async () => {
    if (busy || !document.hidden) return;
    const t = getTrack();
    if (!t || t.readyState !== 'live') return;
    busy = true;
    try {
      const c = await snapshotTrack(t, { imageCaptureOnly: true });
      // Still hidden after the grab: the frame predates any switch to this tab.
      if (c && document.hidden) latest = c;
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), everyMs);
  return {
    latest: () => latest,
    stop: () => {
      clearInterval(timer);
      latest = null;
    },
  };
}

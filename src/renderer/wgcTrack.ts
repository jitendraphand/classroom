import { contentChanged, frameSignature, type FrameSignature } from '../shared/frameChange';
import { desktop } from './bridge';

export type WgcHandle = {
  track: MediaStreamTrack;
  ready: Promise<void>;
  /** Keep publishing the latest frame as a still. New helper frames are ignored. */
  freeze: () => void;
  unfreeze: () => void;
  stop: () => void;
  /** Helper frames received so far (WGC sends one per screen change, capped at the capture fps). */
  frames: () => number;
  /** Helper frames whose pixels differed from the previous one (keep-alives excluded). Drives Video mode. */
  changedFrames: () => number;
  /** Date.now() of the last helper frame (keep-alive included). */
  lastFrameAt: () => number;
};

type StoredFrame = { pixels: Uint8Array; width: number; height: number };

type FrameWriter = {
  desiredSize: number | null;
  write: (frame: VideoFrame) => Promise<void>;
  close: () => Promise<void>;
};

type TrackGenerator = MediaStreamTrack & {
  writable: { getWriter: () => FrameWriter };
};

type TrackGeneratorCtor = new (init: { kind: 'video' }) => TrackGenerator;

type FrameMessage = { width?: number; height?: number; rgba?: Uint8Array };

/**
 * Publishes helper frames as a MediaStreamTrack.
 *
 * The preferred path writes each RGBA buffer into a VideoFrame. Chromium
 * encodes that for WebRTC. MediaStreamTrackGenerator is a Chromium API, so a
 * canvas captureStream remains when it is missing. Strokes are not burned
 * into either path: they are the unprotected annotation window, and the
 * monitor capture already includes them.
 */
export function openWgcTrack(): WgcHandle {
  return openGeneratorTrack() ?? openCanvasTrack();
}

function openGeneratorTrack(): WgcHandle | null {
  const Ctor = (globalThis as { MediaStreamTrackGenerator?: TrackGeneratorCtor }).MediaStreamTrackGenerator;
  if (typeof Ctor !== 'function' || typeof VideoFrame !== 'function') return null;
  let generator: TrackGenerator;
  try {
    generator = new Ctor({ kind: 'video' });
  } catch {
    return null;
  }
  let writer: FrameWriter;
  try {
    writer = generator.writable.getWriter();
  } catch {
    generator.stop();
    return null;
  }
  const track = generator;
  try {
    track.contentHint = 'detail';
  } catch {
    /* ignore */
  }
  let timestampUs = 0;
  let pending: StoredFrame | null = null;
  let busy = false;
  const pump = (markReady: () => void) => {
    if (busy || !pending) return;
    const job = pending;
    pending = null;
    if (writer.desiredSize != null && writer.desiredSize <= 0) return;
    let timestamp = Math.round(performance.now() * 1000);
    timestamp = timestamp > timestampUs ? timestamp : timestampUs + 1;
    timestampUs = timestamp;
    let frame: VideoFrame;
    try {
      frame = new VideoFrame(job.pixels, {
        format: 'RGBA',
        codedWidth: job.width,
        codedHeight: job.height,
        timestamp,
      });
    } catch {
      return;
    }
    markReady();
    busy = true;
    writer.write(frame).then(
      () => {
        frame.close();
        busy = false;
        pump(markReady);
      },
      () => {
        frame.close();
        busy = false;
      }
    );
  };
  return bindFrames({
    track,
    onStop: () => {
      pending = null;
      void writer.close().catch(() => undefined);
    },
    publish: (stored, markReady) => {
      pending = stored;
      pump(markReady);
    },
  });
}

function openCanvasTrack(): WgcHandle {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('no wgc track');
  const paint = (stored: StoredFrame) => {
    if (canvas.width !== stored.width || canvas.height !== stored.height) {
      canvas.width = stored.width;
      canvas.height = stored.height;
    }
    const image = ctx.createImageData(stored.width, stored.height);
    image.data.set(stored.pixels);
    ctx.putImageData(image, 0, 0);
  };
  const track = canvas.captureStream(15).getVideoTracks()[0];
  if (!track) throw new Error('no wgc track');
  try {
    track.contentHint = 'detail';
  } catch {
    /* ignore */
  }
  return bindFrames({
    track,
    onStop: () => undefined,
    publish: (stored, markReady) => {
      paint(stored);
      markReady();
    },
  });
}

function bindFrames(opts: {
  track: MediaStreamTrack;
  publish: (stored: StoredFrame, markReady: () => void) => void;
  onStop: () => void;
}): WgcHandle {
  let stopped = false;
  let frozen = false;
  let last: StoredFrame | null = null;
  let readySettled = false;
  let received = 0;
  let changed = 0;
  let lastAt = 0;
  let lastSig: FrameSignature | null = null;
  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = () => {
      if (readySettled) return;
      readySettled = true;
      resolve();
    };
  });
  const unsub = desktop().onWgcFrame((frame: FrameMessage) => {
    if (stopped || !frame) return;
    const width = frame.width ?? 0;
    const height = frame.height ?? 0;
    const rgba = frame.rgba;
    if (!width || !height || !rgba) return;
    const bytes = width * height * 4;
    if (rgba.byteLength < bytes) return;
    lastAt = Date.now();
    if (frozen && last) {
      try {
        opts.publish(last, resolveReady);
      } catch {
        /* torn frame */
      }
      return;
    }
    // The IPC message is already a private copy, and VideoFrame copies again:
    // no third copy here (3.7 MB per 720p frame, 110 MB/s in video mode).
    received += 1;
    const pixels = rgba.byteLength === bytes ? rgba : rgba.subarray(0, bytes);
    const sig = frameSignature(pixels, width, height);
    if (contentChanged(lastSig, sig)) changed += 1;
    lastSig = sig;
    const stored = { pixels, width, height };
    last = stored;
    try {
      opts.publish(stored, resolveReady);
    } catch {
      /* torn frame */
    }
  });
  return {
    track: opts.track,
    ready,
    freeze: () => {
      frozen = true;
    },
    unfreeze: () => {
      frozen = false;
    },
    frames: () => received,
    changedFrames: () => changed,
    lastFrameAt: () => lastAt,
    stop: () => {
      if (stopped) return;
      stopped = true;
      unsub();
      opts.onStop();
      opts.track.stop();
    },
  };
}

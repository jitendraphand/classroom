'use client';

/**
 * Whole-screen share blackout: the always-on-top Picture-in-Picture share
 * controls (and the chat / roster / video side windows) are painted solid black in every frame before it is published, so
 * students never see them even though a monitor capture records every window.
 *
 * Insertable streams (Chrome/Edge): MediaStreamTrackProcessor → per-frame
 * OffscreenCanvas copy + black rect → MediaStreamTrackGenerator. Driven by the
 * capture's own frames, not timers, so it keeps running while the classroom
 * tab is in the background.
 */
import { planMask, RectTrail, surfaceFromTrack, type Rect, type ScreenGeom } from './screenMask';

type ProcessorCtor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> };
type GeneratorCtor = new (init: { kind: 'video' }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> };

function ctors(): { Processor: ProcessorCtor; Generator: GeneratorCtor } | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { MediaStreamTrackProcessor?: ProcessorCtor; MediaStreamTrackGenerator?: GeneratorCtor };
  if (!w.MediaStreamTrackProcessor || !w.MediaStreamTrackGenerator) return null;
  if (typeof OffscreenCanvas === 'undefined' || typeof VideoFrame === 'undefined') return null;
  return { Processor: w.MediaStreamTrackProcessor, Generator: w.MediaStreamTrackGenerator };
}

export function maskPipelineSupported(): boolean {
  return ctors() !== null;
}

type ScreenDetailed = { left: number; top: number; width: number; height: number };

/**
 * The screens the captured monitor may be, in screen DIPs. Single display →
 * the primary screen at the origin. Several displays → only with the Window
 * Management permission already granted (never prompts mid-share). Otherwise
 * null: positions cannot be mapped, so the caller must not keep the window.
 */
export async function resolveScreenGeometry(): Promise<ScreenGeom[] | null> {
  if (typeof window === 'undefined') return null;
  const scr = window.screen as Screen & { isExtended?: boolean };
  if (scr.isExtended === false) {
    return [{ left: 0, top: 0, width: scr.width, height: scr.height }];
  }
  if (scr.isExtended !== true) return null;
  const w = window as unknown as { getScreenDetails?: () => Promise<{ screens: ScreenDetailed[] }> };
  if (typeof w.getScreenDetails !== 'function') return null;
  try {
    const status = await navigator.permissions.query({ name: 'window-management' as PermissionName });
    if (status.state !== 'granted') return null;
    const details = await w.getScreenDetails();
    const screens = details.screens.map((s) => ({ left: s.left, top: s.top, width: s.width, height: s.height }));
    return screens.length ? screens : null;
  } catch {
    return null;
  }
}

function readWindowRect(win: Window | null): Partial<Rect> | null {
  if (!win || win.closed) return null;
  try {
    return { x: win.screenX, y: win.screenY, w: win.outerWidth, h: win.outerHeight };
  } catch {
    return { x: NaN, y: NaN, w: 0, h: 0 };
  }
}

export type MaskPipeline = {
  /** The processed track to publish instead of the raw capture. */
  track: MediaStreamTrack;
  /** Resolves after the first processed frame (so the track has a size), or after a timeout. */
  ready: Promise<void>;
  stop: () => void;
};

export function startMaskPipeline(
  raw: MediaStreamTrack,
  opts: {
    /**
     * Every floating window to hide (the toolbar PiP plus any chat / roster /
     * video side windows), read on every frame. Empty → nothing to mask.
     */
    getWindows: () => Array<Window | null | undefined>;
    screens: ScreenGeom[];
    /** A window's geometry became unusable: the frame was blacked out; close that window. */
    onUnsafe: (win: Window) => void;
  }
): MaskPipeline | null {
  const c = ctors();
  if (!c) return null;
  const processor = new c.Processor({ track: raw });
  const generator = new c.Generator({ kind: 'video' });
  try {
    generator.contentHint = 'detail';
  } catch {
    /* ignore */
  }
  let canvas: OffscreenCanvas | null = null;
  let ctx: OffscreenCanvasRenderingContext2D | null = null;
  const trail = new RectTrail();
  let firstFrame: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    firstFrame = resolve;
    setTimeout(resolve, 3000);
  });
  const unsafeSent = new WeakSet<Window>();

  const transform = new TransformStream<VideoFrame, VideoFrame>({
    transform(frame, controller) {
      firstFrame();
      const width = frame.displayWidth;
      const height = frame.displayHeight;
      let surface = 'monitor';
      try {
        surface = surfaceFromTrack(
          (raw.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface,
          raw.label
        );
      } catch {
        /* ignore: stays 'monitor' (mask) */
      }
      const wins = opts.getWindows().filter((w): w is Window => !!w && !w.closed);
      // Window/tab capture (after "Share this instead") or no floating window: pass through.
      if (surface === 'window' || surface === 'browser' || wins.length === 0) {
        trail.clear();
        controller.enqueue(frame);
        return;
      }
      let rects: Rect[] = [];
      let blackout = false;
      const now: Rect[] = [];
      for (const win of wins) {
        if (win.closed) continue; // closed since the filter: no longer on screen
        const plan = planMask(readWindowRect(win), opts.screens, { width, height });
        if (plan.kind === 'unsafe') {
          blackout = true;
          if (!unsafeSent.has(win)) {
            unsafeSent.add(win);
            queueMicrotask(() => opts.onUnsafe(win));
          }
        } else {
          now.push(...plan.rects);
        }
      }
      if (!blackout) rects = trail.push(performance.now(), now);
      if (!blackout && rects.length === 0) {
        controller.enqueue(frame);
        return;
      }
      try {
        if (!canvas || canvas.width !== width || canvas.height !== height) {
          canvas = new OffscreenCanvas(width, height);
          ctx = canvas.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D | null;
        }
        if (!ctx) throw new Error('no 2d context');
        ctx.fillStyle = '#000';
        if (blackout) {
          ctx.fillRect(0, 0, width, height);
        } else {
          ctx.drawImage(frame, 0, 0, width, height);
          for (const r of rects) ctx.fillRect(r.x, r.y, r.w, r.h);
        }
        const out = new VideoFrame(canvas, {
          timestamp: frame.timestamp,
          duration: frame.duration ?? undefined,
        });
        frame.close();
        controller.enqueue(out);
      } catch (e) {
        // Never leak: drop the frame (students keep the previous masked one).
        console.warn('screen mask frame', e);
        frame.close();
      }
    },
  });

  void processor.readable
    .pipeThrough(transform)
    .pipeTo(generator.writable)
    .catch(() => undefined);

  return {
    track: generator,
    ready,
    stop: () => {
      try {
        generator.stop();
      } catch {
        /* ignore */
      }
      try {
        raw.stop();
      } catch {
        /* ignore */
      }
    },
  };
}

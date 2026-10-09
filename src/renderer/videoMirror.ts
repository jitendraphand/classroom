/**
 * Student camera frames for the floating "Student videos" window during a
 * share.
 *
 * Why not <video> elements: LiveKit's attach() puts this page's MediaStream on
 * a <video> in the popup, and that stayed blank on Windows. So frames are read
 * here (where the Room lives) with MediaStreamTrackProcessor, scaled to the
 * tile size, and painted as pixels into a <canvas> per tile in the popup.
 *
 * Why tiles froze before (root cause, see REPORT.md "Frozen student tiles"):
 * 1. Each frame went through canvas.toBlob(JPEG). Chromium runs toBlob's
 *    encoder as an idle task; this page is minimized during a share, so idle
 *    tasks starve and every tile waited ~1 s or more per frame (the pump
 *    awaited each JPEG serially).
 * 2. A pump whose reader ended or errored (track muted/replaced, processor
 *    closed) was never reopened: the tile kept its last picture.
 * 3. adaptiveStream turned the publications off: with no element attached in
 *    this page LiveKit counts a track as invisible (0x0) and pauses it, so
 *    tiles relied on a manual setEnabled() racing the adaptive manager.
 *    The room now uses adaptiveStream: false and enables exactly the tiles
 *    on stage (classSession.ensureStudentCameras).
 *
 * Now: no encoder at all (getImageData from a CPU canvas, ~230 KB per tile
 * frame at 320x180), painted straight into the popup (same renderer process,
 * window.open child), at up to 15 fps, with a watchdog that reopens a pump
 * that stopped delivering frames for a live, unmuted track. The JPEG IPC path
 * remains only as a fallback when the popup's paint API is missing, and uses
 * OffscreenCanvas.convertToBlob (not idle-task based).
 *
 * The popup is capture-excluded, so this copy is never part of the share.
 */

export const SHARE_MIRROR_FPS = 15;
export const SHARE_MIRROR_GAP_MS = Math.round(1000 / SHARE_MIRROR_FPS);
export const SHARE_MIRROR_W = 320;
export const SHARE_MIRROR_H = 180;
/** A live, unmuted track without a frame for this long gets a fresh pump. */
export const MIRROR_STALL_MS = 3000;
export const MIRROR_WATCHDOG_MS = 1000;

export function shouldEmitMirrorFrame(now: number, last: number, gapMs = SHARE_MIRROR_GAP_MS): boolean {
  // 2 ms of slack: a 15 fps camera delivers every ~66.6 ms and must not be cut to 7.5 fps.
  return now - last >= gapMs - 2;
}

/** Tile picture size for a frame: fit inside 320x180, keep the camera's aspect. */
export function mirrorSize(srcW: number, srcH: number, maxW = SHARE_MIRROR_W, maxH = SHARE_MIRROR_H): { w: number; h: number } {
  if (!(srcW > 0) || !(srcH > 0)) return { w: maxW, h: maxH };
  const scale = Math.min(maxW / srcW, maxH / srcH, 1);
  return { w: Math.max(2, Math.round(srcW * scale)), h: Math.max(2, Math.round(srcH * scale)) };
}

/** Watchdog rule (pure, tested). */
export function sinkNeedsRestart(s: {
  dead: boolean;
  lastFrameAt: number;
  openedAt: number;
  now: number;
  trackLive: boolean;
  trackMuted: boolean;
}): boolean {
  if (!s.trackLive) return false;
  if (s.dead) return true;
  if (s.trackMuted) return false;
  const since = Math.max(s.lastFrameAt, s.openedAt);
  return s.now - since > MIRROR_STALL_MS;
}

export type MirrorPainter = {
  paint: (key: string, width: number, height: number, rgba: Uint8ClampedArray) => void;
  clear: (key: string) => void;
};

type FrameLike = CanvasImageSource & { close?: () => void; displayWidth?: number; displayHeight?: number };
type Processor = { readable: ReadableStream<FrameLike> };
type ProcessorCtor = new (init: { track: MediaStreamTrack }) => Processor;

type Sink = { track: MediaStreamTrack; stop: () => void; dead: boolean; lastFrameAt: number; openedAt: number };

export class ShareMirror {
  private sinks = new Map<string, Sink>();
  private watchdog = 0;
  private wanted: string[] = [];

  constructor(
    private readonly painter: () => MirrorPainter | null,
    private readonly sendJpeg: (key: string, jpeg: Uint8Array) => void,
    private readonly trackFor: (key: string) => MediaStreamTrack | null
  ) {}

  sync(keys: readonly string[]): void {
    this.wanted = keys.filter((key) => key && !key.startsWith('blank-'));
    const want = new Set(this.wanted);
    for (const [key, sink] of [...this.sinks]) {
      const track = this.trackFor(key);
      if (!want.has(key) || !track || track !== sink.track || track.readyState === 'ended') {
        sink.stop();
        this.sinks.delete(key);
        if (!want.has(key) || !track) this.painter()?.clear(key);
      }
    }
    for (const key of want) {
      if (this.sinks.has(key)) continue;
      const track = this.trackFor(key);
      if (!track || track.readyState === 'ended') continue;
      this.sinks.set(key, this.open(key, track));
    }
    if (this.sinks.size && !this.watchdog) {
      this.watchdog = window.setInterval(() => this.check(), MIRROR_WATCHDOG_MS);
    } else if (!this.sinks.size && this.watchdog) {
      window.clearInterval(this.watchdog);
      this.watchdog = 0;
    }
  }

  /** Drop every pump. A later sync() starts them again. */
  stop(): void {
    for (const sink of this.sinks.values()) sink.stop();
    this.sinks.clear();
    this.wanted = [];
    if (this.watchdog) window.clearInterval(this.watchdog);
    this.watchdog = 0;
  }

  /** Reopen pumps that died or stalled, and pick up replaced tracks. */
  private check(): void {
    const now = performance.now();
    for (const [key, sink] of [...this.sinks]) {
      const track = this.trackFor(key);
      if (track && track !== sink.track) {
        sink.stop();
        this.sinks.delete(key);
        continue;
      }
      const restart = sinkNeedsRestart({
        dead: sink.dead,
        lastFrameAt: sink.lastFrameAt,
        openedAt: sink.openedAt,
        now,
        trackLive: sink.track.readyState === 'live',
        trackMuted: sink.track.muted,
      });
      if (restart) {
        sink.stop();
        this.sinks.delete(key);
      }
    }
    this.sync(this.wanted);
  }

  private open(key: string, track: MediaStreamTrack): Sink {
    const sink: Sink = { track, stop: () => undefined, dead: false, lastFrameAt: 0, openedAt: performance.now() };
    const Processor = (globalThis as { MediaStreamTrackProcessor?: ProcessorCtor }).MediaStreamTrackProcessor;
    if (typeof Processor === 'function') {
      try {
        sink.stop = this.openProcessor(key, sink, new Processor({ track }));
        return sink;
      } catch {
        /* falls through to a same-document video element */
      }
    }
    sink.stop = this.openVideo(key, sink);
    return sink;
  }

  /** Scale a frame to the tile, then paint it in the popup (or send a JPEG). */
  private makeOutput(key: string): (source: CanvasImageSource, srcW: number, srcH: number) => void {
    let canvas: OffscreenCanvas | null = null;
    let ctx: OffscreenCanvasRenderingContext2D | null = null;
    let encoding = false;
    return (source, srcW, srcH) => {
      const size = mirrorSize(srcW, srcH);
      if (!canvas || canvas.width !== size.w || canvas.height !== size.h) {
        canvas = new OffscreenCanvas(size.w, size.h);
        ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
      }
      if (!ctx) return;
      ctx.drawImage(source, 0, 0, size.w, size.h);
      const painter = this.painter();
      if (painter) {
        painter.paint(key, size.w, size.h, ctx.getImageData(0, 0, size.w, size.h).data);
        return;
      }
      if (encoding) return;
      encoding = true;
      void canvas
        .convertToBlob({ type: 'image/jpeg', quality: 0.62 })
        .then((blob) => blob.arrayBuffer())
        .then((buf) => this.sendJpeg(key, new Uint8Array(buf)))
        .catch(() => undefined)
        .finally(() => {
          encoding = false;
        });
    };
  }

  private openProcessor(key: string, sink: Sink, processor: Processor): () => void {
    let stopped = false;
    const reader = processor.readable.getReader();
    const out = this.makeOutput(key);
    let last = 0;
    const finish = () => {
      if (stopped) return;
      stopped = true;
      reader.cancel().catch(() => undefined);
    };
    const pump = async () => {
      while (!stopped) {
        let next: ReadableStreamReadResult<FrameLike>;
        try {
          next = await reader.read();
        } catch {
          break;
        }
        if (next.done || !next.value) break;
        const frame = next.value;
        const now = performance.now();
        sink.lastFrameAt = now;
        if (!shouldEmitMirrorFrame(now, last)) {
          frame.close?.();
          continue;
        }
        last = now;
        try {
          out(frame, frame.displayWidth ?? SHARE_MIRROR_W, frame.displayHeight ?? SHARE_MIRROR_H);
        } catch {
          /* a torn frame: skip it */
        }
        frame.close?.();
      }
      // Ended or errored: the watchdog reopens it while the track is live.
      sink.dead = true;
    };
    void pump();
    return finish;
  }

  private openVideo(key: string, sink: Sink): () => void {
    const track = sink.track;
    const video = document.createElement('video');
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([track]);
    stage().append(video);
    void video.play().catch(() => undefined);
    const out = this.makeOutput(key);
    let stopped = false;
    let lastTime = -1;
    const timer = window.setInterval(() => {
      if (stopped || track.readyState === 'ended') return;
      if (video.readyState < 2) return;
      if (video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        sink.lastFrameAt = performance.now();
      }
      try {
        out(video, video.videoWidth, video.videoHeight);
      } catch {
        /* not decodable yet */
      }
    }, SHARE_MIRROR_GAP_MS);
    return () => {
      if (stopped) return;
      stopped = true;
      window.clearInterval(timer);
      video.pause();
      video.srcObject = null;
      video.remove();
    };
  }
}

function stage(): HTMLElement {
  let host = document.getElementById('mirror-stage');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'mirror-stage';
  host.setAttribute('aria-hidden', 'true');
  document.body.append(host);
  return host;
}

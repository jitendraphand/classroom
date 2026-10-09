/**
 * Copy camera frames into the floating student-video window.
 *
 * That window is its own Electron renderer. LiveKit's attach() builds a
 * MediaStream in this page and assigns it to a video element over there,
 * which stays blank. Frames are read here, where the Room lives, and sent
 * across as small JPEGs. The floating window is capture-excluded, so this
 * copy is not a second encode of the screen share.
 */

export const SHARE_MIRROR_FPS = 8;
export const SHARE_MIRROR_GAP_MS = Math.round(1000 / SHARE_MIRROR_FPS);
export const SHARE_MIRROR_W = 320;
export const SHARE_MIRROR_H = 180;

export function shouldEmitMirrorFrame(now: number, last: number, gapMs = SHARE_MIRROR_GAP_MS): boolean {
  return now - last >= gapMs;
}

type FrameLike = CanvasImageSource & { close?: () => void };

type Processor = { readable: ReadableStream<FrameLike> };
type ProcessorCtor = new (init: { track: MediaStreamTrack }) => Processor;

type Sink = { track: MediaStreamTrack; stop: () => void };

export class ShareMirror {
  private sinks = new Map<string, Sink>();

  constructor(
    private readonly send: (key: string, jpeg: Uint8Array) => void,
    private readonly trackFor: (key: string) => MediaStreamTrack | null
  ) {}

  sync(keys: readonly string[]): void {
    const want = new Set(keys.filter((key) => key && !key.startsWith('blank-')));
    for (const key of [...this.sinks.keys()]) {
      const sink = this.sinks.get(key);
      const track = this.trackFor(key);
      if (!sink) continue;
      if (!want.has(key) || !track || track !== sink.track || track.readyState === 'ended') {
        sink.stop();
        this.sinks.delete(key);
      }
    }
    for (const key of want) {
      if (this.sinks.has(key)) continue;
      const track = this.trackFor(key);
      if (!track || track.readyState === 'ended') continue;
      this.sinks.set(key, { track, stop: this.open(key, track) });
    }
  }

  /** Drop every pump. A later sync() starts them again. */
  stop(): void {
    for (const sink of this.sinks.values()) sink.stop();
    this.sinks.clear();
  }

  private open(key: string, track: MediaStreamTrack): () => void {
    const Processor = (globalThis as { MediaStreamTrackProcessor?: ProcessorCtor }).MediaStreamTrackProcessor;
    if (typeof Processor === 'function') {
      try {
        return this.openProcessor(key, track, new Processor({ track }));
      } catch {
        /* A missing processor falls through to a same-document video element. */
      }
    }
    return this.openVideo(key, track);
  }

  private openProcessor(key: string, track: MediaStreamTrack, processor: Processor): () => void {
    let stopped = false;
    const reader = processor.readable.getReader();
    const canvas = document.createElement('canvas');
    canvas.width = SHARE_MIRROR_W;
    canvas.height = SHARE_MIRROR_H;
    const ctx = canvas.getContext('2d', { alpha: false });
    let last = 0;
    const finish = () => {
      if (stopped) return;
      stopped = true;
      reader.cancel().catch(() => undefined);
    };
    const pump = async () => {
      while (!stopped && track.readyState !== 'ended') {
        let next: ReadableStreamReadResult<FrameLike>;
        try {
          next = await reader.read();
        } catch {
          break;
        }
        if (next.done || !next.value) break;
        const frame = next.value;
        const now = performance.now();
        if (!ctx || !shouldEmitMirrorFrame(now, last)) {
          frame.close?.();
          continue;
        }
        last = now;
        try {
          ctx.drawImage(frame, 0, 0, SHARE_MIRROR_W, SHARE_MIRROR_H);
        } catch {
          frame.close?.();
          continue;
        }
        frame.close?.();
        const jpeg = await canvasJpeg(canvas);
        if (jpeg && !stopped) this.send(key, jpeg);
      }
      finish();
    };
    void pump();
    track.addEventListener('ended', finish, { once: true });
    return finish;
  }

  private openVideo(key: string, track: MediaStreamTrack): () => void {
    const video = document.createElement('video');
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([track]);
    stage().append(video);
    void video.play().catch(() => undefined);
    const canvas = document.createElement('canvas');
    canvas.width = SHARE_MIRROR_W;
    canvas.height = SHARE_MIRROR_H;
    const ctx = canvas.getContext('2d', { alpha: false });
    let last = 0;
    let stopped = false;
    const timer = window.setInterval(() => {
      if (stopped || track.readyState === 'ended' || !ctx) return;
      const now = performance.now();
      if (!shouldEmitMirrorFrame(now, last)) return;
      if (video.readyState < 2) return;
      last = now;
      try {
        ctx.drawImage(video, 0, 0, SHARE_MIRROR_W, SHARE_MIRROR_H);
      } catch {
        return;
      }
      void canvasJpeg(canvas).then((jpeg) => {
        if (jpeg && !stopped) this.send(key, jpeg);
      });
    }, SHARE_MIRROR_GAP_MS);
    const finish = () => {
      if (stopped) return;
      stopped = true;
      window.clearInterval(timer);
      video.pause();
      video.srcObject = null;
      video.remove();
    };
    track.addEventListener('ended', finish, { once: true });
    return finish;
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

function canvasJpeg(canvas: HTMLCanvasElement): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          resolve(null);
          return;
        }
        void blob.arrayBuffer().then(
          (buf) => resolve(new Uint8Array(buf)),
          () => resolve(null)
        );
      },
      'image/jpeg',
      0.62
    );
  });
}

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { videoGrid } from '../shared/classLogic';
import type { VideoModel } from '../shared/videoModel';
import { desktop } from './bridge';

/**
 * Floating "Student videos" window during a share (capture-excluded).
 * Each tile is a <canvas>. The main window's ShareMirror paints camera
 * pixels into it directly (this popup is a window.open child in the same
 * renderer process); see videoMirror.ts for why there is no <video> here.
 */
type VideosApi = {
  ready: boolean;
  setModel: (model: VideoModel) => void;
  whenPainted: (cb: () => void) => void;
  paint: (key: string, width: number, height: number, rgba: Uint8ClampedArray) => void;
  clear: (key: string) => void;
};

const paintWaiters: Array<() => void> = [];
let listener: ((model: VideoModel) => void) | null = null;
let pending: VideoModel = { slots: 6, cells: [] };
const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D | null>();

function feedCanvas(key: string): HTMLCanvasElement | null {
  const el = document.querySelector(`#grid .tile[data-key="${CSS.escape(key)}"] canvas.feed`);
  return el instanceof HTMLCanvasElement ? el : null;
}

function ctxOf(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  let ctx = contexts.get(canvas);
  if (ctx === undefined) {
    ctx = canvas.getContext('2d', { alpha: false });
    contexts.set(canvas, ctx);
  }
  return ctx;
}

function sizeTo(canvas: HTMLCanvasElement, w: number, h: number): void {
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  canvas.parentElement?.classList.add('live');
}

const api: VideosApi = {
  ready: true,
  setModel(model) {
    pending = model;
    listener?.(model);
  },
  whenPainted(cb) {
    paintWaiters.push(cb);
  },
  paint(key, width, height, rgba) {
    const canvas = feedCanvas(key);
    if (!canvas || rgba.byteLength < width * height * 4) return;
    const ctx = ctxOf(canvas);
    if (!ctx) return;
    sizeTo(canvas, width, height);
    // Copy into this window's realm (the array comes from the main window).
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  },
  clear(key) {
    const canvas = feedCanvas(key);
    if (!canvas) return;
    ctxOf(canvas)?.clearRect(0, 0, canvas.width, canvas.height);
    canvas.parentElement?.classList.remove('live');
  },
};

(window as unknown as { classroomVideos?: VideosApi }).classroomVideos = api;
(window as unknown as { classroomVideosReady?: boolean }).classroomVideosReady = true;

/** Fallback path: JPEG over IPC (only when the main window cannot reach `paint`). */
desktop().onVideoTile((key, jpeg) => {
  const canvas = feedCanvas(key);
  if (!canvas) return;
  const bytes = jpeg instanceof Uint8Array ? jpeg : new Uint8Array(jpeg);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  void createImageBitmap(new Blob([copy], { type: 'image/jpeg' })).then(
    (bitmap) => {
      const ctx = ctxOf(canvas);
      if (ctx) {
        sizeTo(canvas, bitmap.width, bitmap.height);
        ctx.drawImage(bitmap, 0, 0);
      }
      bitmap.close();
    },
    () => undefined
  );
});

function Videos() {
  const [model, setModel] = useState<VideoModel>(pending);
  useEffect(() => {
    listener = (next) => setModel(next);
    return () => {
      listener = null;
    };
  }, []);
  useEffect(() => {
    const waiters = paintWaiters.splice(0, paintWaiters.length);
    for (const cb of waiters) cb();
  });
  const grid = videoGrid(model.slots, 'share');
  return (
    <>
      <div className="grip" title="Drag">⋮⋮</div>
      <div
        id="grid"
        style={{
          gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${grid.rows}, minmax(0, 1fr))`,
        }}
      >
        {model.cells.map((cell) => (
          <div className="tile" key={cell.key} data-key={cell.key}>
            <canvas className="feed" width={320} height={180} />
            {cell.label ? <div className="cap">{cell.label}</div> : null}
            {cell.canPin && cell.participantId ? (
              <button
                type="button"
                className={'peer-pin-btn' + (cell.pinned ? ' on' : '')}
                aria-label={cell.pinned ? `Unpin ${cell.label}` : `Pin ${cell.label} (keep in the panel)`}
                title={cell.pinned ? 'Pinned: stays in the panel. Click to unpin.' : 'Pin: keep this student in the panel'}
                onClick={() => desktop().sendAction({ type: 'pin', id: cell.participantId as string, pinned: !cell.pinned })}
              >
                {cell.pinned ? 'Unpin' : 'Pin'}
              </button>
            ) : null}
            {cell.key.startsWith('blank-') ? <div className="empty">Waiting for video</div> : null}
          </div>
        ))}
      </div>
    </>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Videos />);

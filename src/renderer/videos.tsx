import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { videoGrid } from '../shared/classLogic';
import type { VideoModel } from '../shared/videoModel';
import { desktop } from './bridge';

type VideosApi = {
  ready: boolean;
  setModel: (model: VideoModel) => void;
  whenPainted: (cb: () => void) => void;
};

const paintWaiters: Array<() => void> = [];
let listener: ((model: VideoModel) => void) | null = null;
let pending: VideoModel = { slots: 6, cells: [] };

const api: VideosApi = {
  ready: true,
  setModel(model) {
    pending = model;
    listener?.(model);
  },
  whenPainted(cb) {
    paintWaiters.push(cb);
  },
};

(window as unknown as { classroomVideos?: VideosApi; classroomVideosReady?: boolean }).classroomVideos = api;
(window as unknown as { classroomVideosReady?: boolean }).classroomVideosReady = true;

const feedUrls = new Map<string, string>();

function paintFeed(key: string, jpeg: ArrayBuffer | Uint8Array): void {
  const tile = document.querySelector(`#grid .tile[data-key="${CSS.escape(key)}"] img.feed`);
  if (!(tile instanceof HTMLImageElement)) return;
  const copy = new ArrayBuffer(jpeg.byteLength);
  new Uint8Array(copy).set(jpeg instanceof Uint8Array ? jpeg : new Uint8Array(jpeg));
  const blob = new Blob([copy], { type: 'image/jpeg' });
  const url = URL.createObjectURL(blob);
  const prev = feedUrls.get(key);
  feedUrls.set(key, url);
  tile.src = url;
  if (prev) URL.revokeObjectURL(prev);
}

desktop().onVideoTile((key, jpeg) => paintFeed(key, jpeg));

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
  useEffect(() => {
    const keep = new Set(model.cells.map((cell) => cell.key));
    for (const [key, url] of feedUrls) {
      if (keep.has(key)) continue;
      URL.revokeObjectURL(url);
      feedUrls.delete(key);
    }
  }, [model]);
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
            <img className="feed" alt="" />
            {cell.label ? <div className="cap">{cell.label}</div> : null}
            {cell.canPin && cell.participantId ? (
              <button
                type="button"
                className="peer-pin-btn"
                aria-label={cell.pinned ? `Unpin ${cell.label}` : `Pin ${cell.label} (keep in the panel)`}
                title="Pin: keep this student in the panel"
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

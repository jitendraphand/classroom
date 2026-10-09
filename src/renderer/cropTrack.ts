import { regionFrameRect } from '../shared/apiModel';

export type CropHandle = {
  track: MediaStreamTrack;
  stop: () => void;
};

/** One canvas blit of a monitor capture down to the teacher's rectangle. */
export function cropTrack(
  source: MediaStreamTrack,
  region: { x: number; y: number; w: number; h: number },
  display: { x: number; y: number; w: number; h: number }
): CropHandle | null {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([source]);
  void video.play().catch(() => undefined);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;
  let stopped = false;
  const draw = () => {
    if (stopped || video.readyState < 2) return;
    const frame = { width: video.videoWidth, height: video.videoHeight };
    const r = regionFrameRect(region, display, frame);
    if (!r) return;
    if (canvas.width !== r.sw) canvas.width = r.sw;
    if (canvas.height !== r.sh) canvas.height = r.sh;
    ctx.drawImage(video, r.sx, r.sy, r.sw, r.sh, 0, 0, r.sw, r.sh);
  };
  const timer = window.setInterval(draw, 1000 / 15);
  const track = canvas.captureStream(15).getVideoTracks()[0];
  if (!track) {
    clearInterval(timer);
    return null;
  }
  try {
    track.contentHint = 'detail';
  } catch {
    /* ignore */
  }
  return {
    track,
    stop() {
      stopped = true;
      clearInterval(timer);
      track.stop();
      video.srcObject = null;
    },
  };
}

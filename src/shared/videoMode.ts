/**
 * Video mode auto-detect for a Windows.Graphics.Capture share.
 *
 * WGC hands the helper a frame only when the screen changes, capped at the
 * capture rate (8 fps for slides). A video playing on the shared screen keeps
 * that cap full; slides, typing and pointing do not. So:
 * - slides: the frame rate stayed at >= cap - 1 for VIDEO_ON_AFTER_MS → video mode on;
 * - auto video mode: the rate stayed under VIDEO_OFF_FPS for VIDEO_OFF_AFTER_MS → off.
 * Once the teacher toggles Video by hand, `auto` is false and nothing changes
 * by itself until the next share.
 */

export const VIDEO_ON_AFTER_MS = 4000;
export const VIDEO_OFF_FPS = 4;
export const VIDEO_OFF_AFTER_MS = 10000;

export type VideoModeState = {
  on: boolean;
  auto: boolean;
  highSince: number | null;
  lowSince: number | null;
};

export function nextVideoMode(state: VideoModeState, sample: { now: number; fps: number; slidesCap: number }): VideoModeState {
  if (!state.auto) return { ...state, highSince: null, lowSince: null };
  if (!state.on) {
    const busy = sample.fps >= Math.max(2, sample.slidesCap - 1);
    if (!busy) return { ...state, highSince: null, lowSince: null };
    const since = state.highSince ?? sample.now;
    if (sample.now - since >= VIDEO_ON_AFTER_MS) return { on: true, auto: true, highSince: null, lowSince: null };
    return { ...state, highSince: since, lowSince: null };
  }
  const quiet = sample.fps < VIDEO_OFF_FPS;
  if (!quiet) return { ...state, highSince: null, lowSince: null };
  const since = state.lowSince ?? sample.now;
  if (sample.now - since >= VIDEO_OFF_AFTER_MS) return { on: false, auto: true, highSince: null, lowSince: null };
  return { ...state, lowSince: since, highSince: null };
}

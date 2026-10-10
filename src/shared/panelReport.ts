/**
 * Student cameras on demand (web lib/camOnDemand): the teacher reports whether
 * the student-video panel is shown; students in the visible sample publish
 * camera video only while it is. Windows app panels:
 * - not sharing: the main class window's video grid (shown unless the window
 *   is minimized / hidden);
 * - sharing: the floating Student videos window (shown when switched on, open
 *   and not minimized). The main window is behind the shared content then.
 */
export type PanelInputs = {
  sharing: boolean;
  showStudentVideos: boolean;
  videosOpen: boolean;
  videosHidden: boolean;
  mainHidden: boolean;
};

export function panelShownWin(i: PanelInputs): boolean {
  if (i.sharing) return i.showStudentVideos && i.videosOpen && !i.videosHidden;
  return !i.mainHidden;
}

/** Hide reports wait this long (a quick minimize/restore does not bounce every camera); shows are immediate. */
export const PANEL_HIDE_DEBOUNCE_MS = 1500;

/**
 * Debounced reporter: calls `post(open)` only on a settled change.
 * `schedule`/`cancel` are injectable for tests.
 */
export function createPanelReporter(
  post: (open: boolean) => void,
  schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
  cancel: (t: unknown) => void = (t) => clearTimeout(t as ReturnType<typeof setTimeout>)
) {
  let reported: boolean | null = null;
  let pending: unknown = null;
  let want: boolean | null = null;
  return {
    update(open: boolean) {
      if (want === open) return;
      want = open;
      if (pending !== null) cancel(pending);
      pending = null;
      if (reported === open) return;
      const fire = () => {
        pending = null;
        if (reported === want || want === null) return;
        reported = want;
        post(want);
      };
      if (open) fire();
      else pending = schedule(fire, PANEL_HIDE_DEBOUNCE_MS);
    },
    /** Forget what was sent (new class / reconnect): the next update posts again. */
    reset() {
      if (pending !== null) cancel(pending);
      pending = null;
      reported = null;
      want = null;
    },
  };
}

# Share HUD — teach while screen sharing

Compact **teacher-only** control bar while the teacher is screen sharing.
Students never see this chrome — only the shared screen + annotations.

## Where the controls live

The bar is **not** painted in the classroom page. It renders (via a React
portal from `ClassroomRoom.tsx`) into a separate small window:

1. **Document Picture-in-Picture** (Chromium desktop: Chrome, Edge). An
   always-on-top window, requested at 860×64 and fitted to the bar (≈520×62).
   It is never captured, even when the teacher shares the entire screen.
2. **Pop-up fallback**: `public/share-controls.html`, a static same-origin page
   opened with `window.open` (Firefox, Safari, or when PiP is refused). It is a
   normal window, so it **is** captured when the whole screen is shared; the
   page then warns the teacher to move it or share a window/tab instead. The
   static file is used instead of a Next route (`/hud` only redirects there)
   so the popup does not boot the app layout and its idle-logout timer.

`getDisplayMedia` and the controls window are both started synchronously in
the same click (`toggleScreen` → `beginShareControls()` + `captureScreen()`),
before any `await`, so one click is enough. The pop-up is pre-opened on
pointer-down for browsers that need a fresh gesture for each call.

If the browser blocks the window, sharing continues and the page shows
**Open share controls**. Closing the window (✕) does not stop sharing.

## Layout of the bar

- The toolbar (Live, mic, Annotate, chat, hands, roster, waiting badge,
  **Admit &lt;name&gt;** / Admit all, **Stop**) is rendered **first** and is
  `position: sticky` at the top, so it stays visible even when the window
  cannot grow.
- Chat / hands / roster panels open **below** the bar, only on click. The
  window grows to fit (`resizeTo`), but PiP and pop-ups only allow that with a
  user gesture; if it is refused, the panel area scrolls under the bar.
- A newly waiting student does **not** auto-open the roster (that used to push
  the toolbar out of the 62 px window). The roster icon shows a waiting badge
  and the bar shows an **Admit &lt;name&gt;** button.

## Teacher's own page (sharing or not)

- The **Class** panel (2/4/6 student-camera mosaic; the first tile is the
  teacher) is docked to the stage's top-left corner, never floating over it.
  The stage leaves room for it: a top band when minimized, a left column when
  expanded. On narrow stages (< 640 px) the expanded panel is a top band
  limited to about half the stage height, with the stage below it.
- While sharing, the panel starts **minimized** at every share; when not
  sharing, the teacher's saved minimized/expanded choice is kept.
- Student cameras appear only in the Class panel (never again on the stage),
  and the teacher's own tile stays inside the panel or the stage, clear of
  the bottom controls. 2 and 4 are one column, 6 is 2×3 (blank tiles fill
  empty slots), hard max 6; speaker pinning and rotation are unchanged.

## History

| Issue | Root cause | Fix |
|---|---|---|
| First click opened controls, second click started share | The controls window consumed the user gesture before `getDisplayMedia` | Start capture and the controls window in the same click turn, before any await |
| Control panel too bulky | Full sheet / 300×420 PiP with always-visible chat | Slim bar; chat / hands / roster open from icons only |
| Mobile silent no-op | Share failure swallowed | Detect `getDisplayMedia`; show a clear notice |
| Toolbar vanished when a student started waiting (2026-10-01) | Roster auto-opened above the bar; `resizeTo` refused without a gesture | No auto-open; bar first + sticky; panel scrolls |
| Teacher view cluttered while sharing (2026-10-01) | Class float over the stage + duplicate camera strip | Class panel docked/minimized; strip removed during share |
| Same clutter when not sharing (2026-10-02) | Class float over the stage + student cameras repeated on the stage | Panel docked in both views; stage shows no student cameras |

## Files

| File | Role |
|---|---|
| `TeacherShareHud.tsx` | PiP / pop-up window management + compact bar and panels |
| `public/share-controls.html` | Static pop-up host page (fallback) |
| `ScreenAnnotator.tsx` | Annotation overlay + LiveKit transport |
| `ClassroomRoom.tsx` | One-click `toggleScreen`; teacher-only HUD; docked Class panel |
| `app/api/rooms/[code]/annotate/route.ts` | Redis snapshot for late joiners |

## Browser limits (mobile)

- **iOS Safari / many iPhone browsers:** `getDisplayMedia` is unavailable. The share button shows an explanation instead of doing nothing. Prefer a computer or Android Chrome.
- **Android Chrome:** No Document PiP; the pop-up fallback is used where allowed.
- **Desktop Chromium:** One click starts share + opens the PiP bar. **Firefox/Safari:** one click starts share + the pop-up.

## How to try

1. Teacher starts class → **Share screen** once.
2. Pick a surface; the slim **Share** bar opens in a small always-on-top window (Chromium) or a pop-up.
3. Students see only the shared screen (+ annotations when the teacher draws).
4. Closing the bar window (✕) does **not** stop sharing — use **Open share controls** or **Stop**.

## Entire-screen sharing (Oct 2026)

A monitor ("Entire screen") capture records every window on that screen, including the
always-on-top Document Picture-in-Picture controls and the `share-controls.html` pop-up.
No `getDisplayMedia` hint (`selfBrowserSurface`, `monitorTypeSurfaces`, `surfaceSwitching`)
and no Region/Element Capture can exclude another window from a monitor capture.

Rule (`shareControlsPlacement()` in `src/lib/floatGeometry.ts`):

- `displaySurface === 'monitor'`: the PiP/pop-up opened in the click is closed **before the
  track is published**, and the same controls render inside the classroom tab
  (`InlineShareDock`, draggable). A hint tells the teacher that sharing a window or tab
  brings the floating controls back.
- `window` / `browser` / unknown: floating PiP (or pop-up) as before. It is not part of
  the captured surface.
- The live track is re-checked every 1.5 s, so switching to the entire screen mid-share
  ("Share this instead") closes the floating window too. "Pop out" is never offered
  during a monitor capture.
- `selfBrowserSurface: 'exclude'`: the classroom tab itself is not offered in the picker.

## Floating controls over an entire-screen share: blackout mask (Oct 2026, supersedes the rule above on Chrome/Edge)

- The PiP controls now stay open during a monitor capture. The published track is not the
  raw capture: `lib/screenMaskPipeline.ts` (MediaStreamTrackProcessor → OffscreenCanvas →
  MediaStreamTrackGenerator) paints the PiP window's rectangle black in every frame.
  Same 1080p15 + 720p simulcast publish; driven by capture frames, so it keeps running
  while the classroom tab is in the background.
- Mapping (`lib/screenMask.ts`, unit-tested): frame px = (window DIP − screen origin) ×
  frame/screen size, +16 DIP margin, union of the window rects seen in the last 350 ms
  (covers capture lag while dragging). Position is re-read on every frame.
- Screens: single display (`screen.isExtended === false`) → primary at the origin. Several
  displays → only with the Window Management permission already granted
  (`getScreenDetails`); otherwise the PiP is closed before publishing and the in-tab dock
  shows an "Allow" button for the next share. Screens whose aspect ratio does not match
  the frame are not candidates; two identical monitors are both masked.
- Unusable geometry mid-share (window size 0, no matching screen): that frame is fully
  black and the PiP is closed. Firefox/Safari (no insertable streams): PiP-less, the
  in-tab dock as before.
- Controls open as a compact pill (Live dot + chat / hand / waiting badges, Admit, mic,
  Stop); click to expand, ◂ to collapse; the PiP resizes to fit.
- Teacher stage keeps the static card for monitor shares and Annotate stays off there:
  drawing needs a live preview of the capture, and showing the capture on the captured
  screen recurses regardless of the mask.

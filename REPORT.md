# Report

Classroom Teacher is an Electron app for the teacher. Students stay in the web app. Screen video is Windows.Graphics.Capture from `native/affinity-helper.exe`. Every opaque classroom window is capture-excluded by `setContentProtection(true)` in the Electron process, checked with `isContentProtected()`. That covers the control panel, the main window, roster, messages, devices, the video panel, and the capture-test window. The annotation overlay is not protected. A separate EXE does not call `SetWindowDisplayAffinity`: that call fails unless the HWND belongs to the caller. If Graphics Capture does not start, nothing is published.

## Annotation

Two windows:

- The control panel is an opaque, always-on-top Electron window. It holds the buttons and the tools. After it exists, this process calls `setContentProtection(true)` and logs `isContentProtected()`. The same call runs on the main window, roster, messages, devices, the video panel, and the capture-test window. The teacher sees those windows. The observer does not, and the observer sees the pixels that were under them. Capture waits for one desktop composition after that call.
- The annotation overlay is a separate frameless transparent window over the shared monitor. `setContentProtection` is not called on it. Strokes on the overlay are part of the monitor image. Outside the strokes the window is fully transparent. With annotate off it is click-through (`setIgnoreMouseEvents` and `WS_EX_TRANSPARENT`) and not focusable, so the application underneath takes mouse and keyboard. The region picker is also left unprotected: it is transparent, and excluding a layered window composites as a black rectangle.

On Windows 10 2004 and later Electron’s `setContentProtection(true)` is `WDA_EXCLUDEFROMCAPTURE`, so the observer sees the pixels under each protected window.

Tools on the “Annotate tools” panel (its own capture-excluded window), drawn only on the overlay: pen, arrow, line, rectangle, ellipse, text, highlight, eraser, undo, redo, clear. The laser is a fading glow and is not stored. Shapes are vectors (`id`, `type`, `points`, `color`, `width`, `opacity`, `text`, `timestamp`). Points are 0–1 of the captured monitor’s physical size (`x / screenWidthPx`, `y / screenHeightPx`). A CSS pointer is turned into device pixels with that monitor’s scale, then placed in the physical rectangle from `dipToScreenRect`. The DIP origin is not multiplied by the scale, so a 150% monitor beside a 100% monitor lines up. The overlay follows that display’s resolution, DPI, and position, including a monitor whose origin is negative.

The website no longer has teacher annotation or the `annotate` data topic (it was replaced by student drawing). The Windows app neither publishes nor listens on `annotate`: the teacher's marks exist only on the captured overlay, so students see them once, in the video.

Every published share captures the whole monitor with `CreateForMonitor`. Choosing a window resolves that window’s monitor (`MonitorFromWindow`) and uses the same call, so the annotation overlay is in the frame. Strokes stay on that overlay. They are not also drawn into the D3D11 texture. Opaque classroom windows are excluded by `setContentProtection` in this process. The overlay is not.

## Window protection (every window decided)

`WINDOW_CAPTURE_DECISIONS` in `src/shared/capture.ts` lists each window; `tests/windowProtection.test.ts` checks it against `windowShouldBeCaptureExcluded()` and against every window name `main.ts` registers, and checks that the new tool panel is protected before its first show. Unknown names default to excluded.

| Window | In the share? | Why |
| --- | --- | --- |
| main (class window) | excluded | minimised during a share; opaque |
| toolbar (share controls) | excluded | opaque floating panel |
| chat, roster, devices | excluded | opaque panels |
| classroom-videos | excluded | opaque; canvas tiles |
| **annotate-tools** (new) | excluded | opaque tool panel; `setContentProtection(true)` before the first `show()` |
| annotate-preview, capture-test | excluded | opaque |
| annotate-overlay | **captured** | transparent; carries the teacher's marks and the students' desktop ink |
| region-picker | captured | transparent; closes before the share starts; excluding it paints black |

Nothing about the existing exclusion path changed: same `setContentProtection` / `WDA_EXCLUDEFROMCAPTURE` on opaque windows, same WGC `CreateForMonitor` helper.

## Frozen student tiles (root cause)

During a share the student videos window froze (tiles kept an old picture, or updated about once a second). Three causes, all in the copy from the class window to the videos window:

1. Every tile frame went through `canvas.toBlob('image/jpeg')`. Chromium runs that encoder as an idle task. The class window is minimised during a share, so idle tasks starve; the pump awaited each JPEG before reading the next frame, so a tile got a frame every second or more.
2. A pump whose `MediaStreamTrackProcessor` reader ended or errored (track muted, replaced, resubscribed) was never reopened. That tile kept its last picture for the rest of the share.
3. `adaptiveStream` paused the cameras: with no element attached in the class window, LiveKit reports the tracks as invisible (0×0) and stops them; the manual `setEnabled()` raced the adaptive manager.

Fix (`src/renderer/videoMirror.ts`, `videos.tsx`, `classSession.ts`): the room uses `adaptiveStream: false` and enables exactly the cameras on stage; frames are drawn into an `OffscreenCanvas` and `getImageData` pixels are painted straight into canvases in the videos window (a same-process `window.open` child), at 15 fps, with no encoder; a 1 s watchdog reopens a pump that delivered nothing for 3 s on a live, unmuted track. JPEG over IPC remains only as a fallback and uses `convertToBlob` (not idle-task based). `tests/videoMirror.test.ts` covers the frame gap, the tile size and the watchdog rule.

## Student drawing on the desktop (ink capture decision)

When the teacher allows a student to draw (roster Allow, or the request notice), the student draws in the web app as before (`draw` data topic, `apps/web/src/lib/drawLogic.ts`, shared byte for byte). The Windows app receives those packets (the server sends them without a participant) and draws the strokes on the transparent overlay over the shared monitor. That overlay is captured, so the strokes are in the video every student sees, exactly where the student put them on the teacher's real desktop. Region shares map the strokes into the region (`inkRectFor`). Stroke width and name tags follow the website (`strokeWidthFor`, `nameTags`).

Decision: the ink window is **captured, not protected**. Protecting a transparent window composites as a black box on Windows 10, and the strokes have to be in the picture anyway. Because the strokes are now in the video, the website must not draw them a second time: the Windows app starts the share with `POST /stage {mode:'screen', desktopInk:true}`, the server keeps `room:CODE:desktop-ink`, the state returns `desktopInk: true`, and the web overlay then draws nothing for viewers and only the drawer's own fresh strokes (touched within 1.5 s, so the line appears under the pen before the video catches up). The website's own browser share does not set the flag and is unchanged. Allow, Revoke and Clear drawing are in the roster (both windows) and the share notice.

## Annotation panel

A separate window, “Annotate tools” (`tools.tsx`), 212×452, under the share controls, position remembered. Pen, highlighter, line, arrow, rectangle, ellipse, text, laser, eraser, undo / redo, clear, colour swatches plus a picker, thickness 1–12, and Draw / Click-through (the overlay takes the mouse, or passes clicks to the apps below while marks stay). Opaque and capture-excluded. Shortcuts: P H L A R O T K E, Ctrl+Z, Ctrl+Y. The overlay caches committed shapes in a second canvas so a long annotation session no longer redraws every shape per frame.

## Video mode

The share HUD's Video button, as on the website: `contentHint = 'motion'`, `degradationPreference = 'maintain-framerate'`, 30 fps, 1.5 Mbps on the single 1280×720 layer (`VIDEO_MODE_SHARE`). The WGC helper is restarted at 30 fps (`wgc-fps` IPC, same source and size) and back to 8 fps when it is off. Auto-detect (`src/shared/videoMode.ts`): a screen that keeps the 8 fps cap full for 4 s turns it on, under 4 fps for 10 s turns it off; pressing Video stops auto for that share. Pressing Video on also tries to add system audio (loopback) if the share had none. Cost: 30 fps is about 3.7× the slide readback and encode (each frame is a 3.7 MB BGRA→RGBA readback at 720p); fine on a current laptop, noticeable on an old dual-core.

## Performance review

Fixed:

- Windows class window: roster and chat were rebuilt from scratch (`replaceChildren`) on every class update; now React views, and only the visible pane renders.
- Class updates are coalesced to one emit per 16 ms, and the HUD snapshot sent to every floating window is skipped when unchanged (JSON compare).
- WGC frame path: one extra 3.7 MB copy per frame removed (`wgcTrack.ts`).
- Annotation overlay: committed shapes cached in a base canvas (was: every shape redrawn per pointer move); eraser moves that hit nothing no longer repaint or send IPC.
- Student tiles: no JPEG encoder on the idle queue (see above).
- Website: viewers draw nothing on a Windows desktop-ink share (one less SVG layer over the video); the drawer's fade timer runs only while there is fresh ink.

Not changed (listed):

- RGBA, not NV12, crosses the helper pipe (≈3.7 MB per 720p frame); NV12 would halve it but needs a converter in the helper and in the renderer.
- The HUD snapshot carries the last 100 messages to every floating window on each change.
- Web `ClassroomRoom.tsx` is a 4,500-line component; most state changes re-render it. Splitting it is a larger refactor.
- Web: `usePictureRect` measures every 1.5 s as a safety net beside its observers; a share HUD window prune timer runs every 400 ms while side windows are open.
- Polling: state and chat polling follow the web policy (`pollPolicy.ts`); LiveKit nudges keep them slow while the push channel is live.

## Tiles

Each floating video tile is one twentieth of the work-area width, 16:9, with a minimum of 48. On 1920×1080 that is 96×54. The window is about 200×72 for 2, 200×130 for 4, and 300×130 for 6. An earlier area-based size was about 322px wide on that display, which was already too large, so the divisor is the width and not the area.

## Why the earlier build showed black boxes

The previous package fell back to a Chromium capture when Windows.Graphics.Capture failed. Chromium’s capturer is DXGI Desktop Duplication, which paints `WDA_EXCLUDEFROMCAPTURE` windows black. The fallback also cleared the affinity and painted the panels black into that frame. This build has no such path. `maskTrack.ts` is gone. A failed capture refuses the share. Panels are opaque. The helper manifest declares Windows 10 and PerMonitorV2.

## What this machine verified

Linux, with Wine used only to package. Electron 36.9.5. `npm run typecheck` (`tsc --noEmit`) completed with no errors. `npm test` passed 84 tests, including: every window's capture decision (`windowProtection`), the website-copied modules being byte-identical (`webSync`), the roster and chat rendered to HTML with the website's labels (`teacherViews`), dashboard / ad-hoc / Video mode / encodings / ink mapping (`teacherParity`), the tile watchdog (`videoMirror`), plus the earlier capture, annotation-coordinate, chat and waiting-room tests. The website: `npm run typecheck` clean, `npm test` 233/233 (`next lint` is not configured in that repo and only prompts). `native/affinity-helper.exe` is unchanged (sha256 `c9bb28aa…d70f8`). The packaged files are `dist/ClassroomTeacher-setup.exe` (88,558,939 bytes) and `dist/ClassroomTeacher-portable.exe` (88,352,142 bytes), also under `release/`; `app.asar` contains `dist/renderer/tools.html` and `tools.js`. Built 2026-10-09. Signing was skipped.

## What only a Windows PC can verify

The Notepad capture test saves real Windows.Graphics.Capture frames and scores those pixels. It does not treat `isContentProtected()` as proof by itself, and a probe that did not run is SKIP rather than PASS. Wine does not implement Windows.Graphics.Capture, so this host cannot show that the observer’s frame matches the tests in `TESTING.md` section 5:

- The control panel is visible locally and absent from the stream.
- Pixels under the panel remain visible. No black box.
- A stroke is visible to the observer and disappears on Clear.
- The application underneath receives input when annotate is off.
- 100%, 125%, 150%, and 200% scaling, and a second monitor.
- Dragging the panel, and drawing over Chrome, Notepad, Explorer, and a GPU-accelerated window.
- New in this build, untested on Windows: the “Annotate tools” window being absent from the stream (it is protected exactly like the toolbar), student desktop ink landing in the right place at each scale and on a region share, the student tiles staying live for a long share, Video mode at 30 fps (helper restart, CPU), its auto-detect thresholds on real content, loopback audio from the Video button, and the new look of every page.

The capture-exclusion test on that PC should show the control panel, main window, videos, roster, and chat as `protected=yes` from `isContentProtected()`, and the annotation overlay as `protected=no`. The log is `%APPDATA%\Classroom Teacher\capture.log`. Do not send `config.json`. A helper exit code is not an affinity result.

## Known risks

Calling `setContentProtection(true)` on the transparent annotation overlay would remove the strokes from the capture. The same call on the transparent region picker would cover the desktop with a black rectangle. Opaque classroom windows are protected. On Windows older than 10 2004, Electron’s protection behaves as `WDA_MONITOR` and the observer sees a black rectangle. This app targets Windows 10 2004 and later.

Choosing a window still captures that window’s whole monitor, so the overlay is in the frame.

The laser and the in-progress stroke are redrawn on the overlay only. They are not a permanent change to the desktop.

No GitHub release was published.

## Fixes after the real-Windows E2E (2026-10-09 → 2026-10-10)

1. **Frozen share after RDP reconnect / display or session change.** The helper re-sent its last texture every 250 ms as a keep-alive, so a WGC session that stopped producing frames looked alive. The helper now watches for device loss, monitor geometry change, remote/console session change, unlock (input desktop back to Default) and a GDI-vs-WGC freeze probe, emits `{"event":"stale"}` and exits 3. `src/main/captureSupervisor.ts` restarts the capture (debounced, back-off 0/1/2/4/8 s) with the monitor re-resolved, also on display-added/removed/metrics-changed, unlock-screen and resume, and when no helper frame arrives for 3 s. The renderer's MediaStreamTrack is fed by IPC, so the published track is unchanged. If every attempt fails the share stops with a notice.
2. **No video sound for students.** getDisplayMedia() needs a user gesture in the class window; Video mode is toggled from the control panel or automatically, so it was always refused. Loopback now uses desktop getUserMedia (`chromeMediaSource: 'desktop'`, WASAPI loopback, no gesture), with getDisplayMedia as fallback. Sound follows Video mode (auto) and has a Sound button on the control panel.
3. **Auto Video mode never switched back.** Keep-alive frames (4/s) and repaints of excluded windows were counted as motion; the off threshold was < 4/s. Video mode now counts frames whose pixels changed (`src/shared/frameChange.ts`) and is not switched on while annotating.
4. **Blank unlabeled video tile.** The server's visible sample can name a student without a camera (iPhone/iPad, camera off). Such students now fill the slot with their name ("· camera off"), and no blank cells are painted.
5. **Ink not reaching students / teacher strokes not starting.** In a GPU-less or RDP session Chromium draws the transparent overlay as a per-pixel-alpha layered window: alpha-0 pixels are hit-test transparent (the pen never got pointer events) and the WGC monitor texture did not contain the window. Draw mode now gives the overlay an invisible 1/255 background, and the overlay renders its canvas at the published frame size and sends the inked bounding box to main, which alpha-blends it into every frame (`src/shared/inkLayer.ts`) unless the captured frame already shows it (no double ink). Students, including the one drawing, see strokes through the share.

### Whole-screen share cropped to the top-left (2026-10-10)
The helper created its Windows.Graphics.Capture frame pool at the output size (the monitor fitted into 1280×720). WGC does not scale into the pool; it copies the top-left pool-sized block of the monitor, so any monitor larger than 1280×720 (1080p, 16:10, 4K, ultrawide, any DPI scaling) lost its right side and bottom (taskbar). The pool is now the item's full physical size; the frame is scaled to fit on the GPU (CPU fallback), aspect preserved. A frame whose ContentSize differs from the pool (resolution/scaling changed) makes the helper report `stale display-changed` so the supervisor restarts with a new pool. Geometry tests: tests/captureGeometry.test.ts (5 scale factors × 9 monitor shapes, multi-monitor offsets, region and ink mapping).

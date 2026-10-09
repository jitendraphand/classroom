# Report

Classroom Teacher is an Electron app for the teacher. Students stay in the web app. Screen video is Windows.Graphics.Capture from `native/affinity-helper.exe`. Every opaque classroom window is capture-excluded by `setContentProtection(true)` in the Electron process, checked with `isContentProtected()`. That covers the control panel, the main window, roster, messages, devices, the video panel, and the capture-test window. The annotation overlay is not protected. A separate EXE does not call `SetWindowDisplayAffinity`: that call fails unless the HWND belongs to the caller. If Graphics Capture does not start, nothing is published.

## Annotation

Two windows:

- The control panel is an opaque, always-on-top Electron window. It holds the buttons and the tools. After it exists, this process calls `setContentProtection(true)` and logs `isContentProtected()`. The same call runs on the main window, roster, messages, devices, the video panel, and the capture-test window. The teacher sees those windows. The observer does not, and the observer sees the pixels that were under them. Capture waits for one desktop composition after that call.
- The annotation overlay is a separate frameless transparent window over the shared monitor. `setContentProtection` is not called on it. Strokes on the overlay are part of the monitor image. Outside the strokes the window is fully transparent. With annotate off it is click-through (`setIgnoreMouseEvents` and `WS_EX_TRANSPARENT`) and not focusable, so the application underneath takes mouse and keyboard. The region picker is also left unprotected: it is transparent, and excluding a layered window composites as a black rectangle.

On Windows 10 2004 and later Electron’s `setContentProtection(true)` is `WDA_EXCLUDEFROMCAPTURE`, so the observer sees the pixels under each protected window.

Tools on the panel, drawn only on the overlay: pen, arrow, line, rectangle, ellipse, text, highlight, eraser, undo, redo, clear. The laser is a fading glow and is not stored. Shapes are vectors (`id`, `type`, `points`, `color`, `width`, `opacity`, `text`, `timestamp`). Points are 0–1 of the captured monitor’s physical size (`x / screenWidthPx`, `y / screenHeightPx`). A CSS pointer is turned into device pixels with that monitor’s scale, then placed in the physical rectangle from `dipToScreenRect`. The DIP origin is not multiplied by the scale, so a 150% monitor beside a 100% monitor lines up. The overlay follows that display’s resolution, DPI, and position, including a monitor whose origin is negative.

Local marks are not published on the `annotate` topic. The website would draw them again as SVG on top of a video that already contains them. The host sends an empty snapshot so that SVG layer stays clear. A packet that arrives on `annotate` is drawn on the overlay and is not echoed. If it carries `screenWidthPx` and `screenHeightPx`, its points are physical pixels and are normalised first.

Every published share captures the whole monitor with `CreateForMonitor`. Choosing a window resolves that window’s monitor (`MonitorFromWindow`) and uses the same call, so the annotation overlay is in the frame. Strokes stay on that overlay. They are not also drawn into the D3D11 texture. Opaque classroom windows are excluded by `setContentProtection` in this process. The overlay is not.

## Tiles

Each floating video tile is one twentieth of the work-area width, 16:9, with a minimum of 48. On 1920×1080 that is 96×54. The window is about 200×72 for 2, 200×130 for 4, and 300×130 for 6. An earlier area-based size was about 322px wide on that display, which was already too large, so the divisor is the width and not the area.

## Why the earlier build showed black boxes

The previous package fell back to a Chromium capture when Windows.Graphics.Capture failed. Chromium’s capturer is DXGI Desktop Duplication, which paints `WDA_EXCLUDEFROMCAPTURE` windows black. The fallback also cleared the affinity and painted the panels black into that frame. This build has no such path. `maskTrack.ts` is gone. A failed capture refuses the share. Panels are opaque. The helper manifest declares Windows 10 and PerMonitorV2.

## What this machine verified

Linux, with Wine used only to package. Electron is 36.9.5, which provides `isContentProtected()`. `npx tsc --noEmit` completed with no errors. `npm test` passed 59 tests, including the rule that every opaque classroom window is capture-excluded and the annotation overlay and region picker are not, the Notepad frame checks (panel chrome, black rectangle, red arrow, and a skipped probe), and the physical-pixel monitor match. `strings` on `native/affinity-helper.exe` shows `CreateForMonitor`, `capture-monitor`, `capture-window`, and `Windows.Graphics.Capture`, and does not show `CreateForWindow` or `SetWindowDisplayAffinity`. `capture-window` resolves the monitor and then calls `CreateForMonitor`. The packaged installers are `dist/ClassroomTeacher-setup.exe` (88,076,580 bytes) and `dist/ClassroomTeacher-portable.exe` (87,869,793 bytes), also copied under `release/`. Built 2026-10-07. Signing was skipped.

## What only a Windows PC can verify

The Notepad capture test saves real Windows.Graphics.Capture frames and scores those pixels. It does not treat `isContentProtected()` as proof by itself, and a probe that did not run is SKIP rather than PASS. Wine does not implement Windows.Graphics.Capture, so this host cannot show that the observer’s frame matches the tests in `TESTING.md` section 5:

- The control panel is visible locally and absent from the stream.
- Pixels under the panel remain visible. No black box.
- A stroke is visible to the observer and disappears on Clear.
- The application underneath receives input when annotate is off.
- 100%, 125%, 150%, and 200% scaling, and a second monitor.
- Dragging the panel, and drawing over Chrome, Notepad, Explorer, and a GPU-accelerated window.

The capture-exclusion test on that PC should show the control panel, main window, videos, roster, and chat as `protected=yes` from `isContentProtected()`, and the annotation overlay as `protected=no`. The log is `%APPDATA%\Classroom Teacher\capture.log`. Do not send `config.json`. A helper exit code is not an affinity result.

## Known risks

Calling `setContentProtection(true)` on the transparent annotation overlay would remove the strokes from the capture. The same call on the transparent region picker would cover the desktop with a black rectangle. Opaque classroom windows are protected. On Windows older than 10 2004, Electron’s protection behaves as `WDA_MONITOR` and the observer sees a black rectangle. This app targets Windows 10 2004 and later.

Choosing a window still captures that window’s whole monitor, so the overlay is in the frame.

The laser and the in-progress stroke are redrawn on the overlay only. They are not a permanent change to the desktop.

No GitHub release was published.

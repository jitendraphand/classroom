# Classroom Teacher (Windows)

Desktop app for the teacher of the existing classroom. Students keep using the web app in Chrome or Edge. Nothing here is a second classroom server.

Windows 10 version 2004 (build 19041) and Windows 11. The panels float on the teacher’s desktop. Students must see the pixels underneath those panels, not the panels and not black rectangles.

## Releases

- 1.1.0 (2026-10-28): see [docs/RELEASE-1.1.0.md](docs/RELEASE-1.1.0.md) for changes, checksums and what was tested.

## Layout

```
windows/
  electron-builder.yml    NSIS + portable, output in release/, then copied to dist/
  native/
    affinity-helper.c     Win32 helper: Windows.Graphics.Capture, DwmFlush, click-through
    helper.manifest       Win10/11 supportedOS, maxversiontested 10.0.19041.0
    helper.rc             embeds that manifest (RT_MANIFEST)
    affinity-helper.exe   mingw build of the helper
  src/main/               Electron main: windows, cookie jar, helper, WGC pump
  src/preload/            contextBridge (no node in the renderer)
  src/renderer/           React panels and the class session
    engine.ts             login, dashboard (campus → grade → divisions), in-class stage
    teacherViews.tsx      roster and chat, same as the website (main window and panels)
    toolbar.tsx           floating share controls (the website's share HUD)
    tools.tsx             annotation tool panel (own capture-excluded window)
    panel.tsx             chat, roster, devices windows
    videos.tsx            2/4/6 tiles
    annotate.ts           transparent overlay: vector strokes on the shared monitor
    captureTest.tsx       local preview of what a share would contain
    classSession.ts       LiveKit publish + the same HTTP API as the website
  src/shared/             pure logic, unit-tested on Linux
  src/shared/web/         byte copies of the website's lib modules (scripts/sync-web.mjs)
  tests/                  node:test
  scripts/build-helper.sh mingw cross-compile
  scripts/build-win.sh    helper, bundle, electron-builder, copy into dist/
  scripts/bundle.mjs      esbuild (React JSX automatic)
  dist/                   main.js plus ClassroomTeacher-setup.exe and ClassroomTeacher-portable.exe
  release/                electron-builder output (same two exes, plus win-unpacked)
```

`e2e-sim/` and `ux-review/` are earlier live-class reports. They are not part of the installer.

## Run and build

```
cd /workspace/windows
npm ci
npm test
npm run typecheck
bash scripts/build-helper.sh
npm run build
npm start
```

`npm run dist:win` (or `bash scripts/build-win.sh`) needs Wine. It writes `release/ClassroomTeacher-setup.exe` and `release/ClassroomTeacher-portable.exe`, then copies both into `dist/`. electron-builder’s output directory is `release/`, not `dist/`, because `package.json` `"main"` is `dist/main.js` and a clean of `dist/` would delete the bundle. The app is not code-signed. `signAndEditExecutable` stays on so the exe receives the icon and version resource. `forceCodeSigning` stays off because there is no certificate. Wine’s rcedit exits with “Unable to commit changes” on this host, so the build script puts a `wine` shim first on `PATH` for that one call and applies the same edit with the `resedit` library. NSIS still runs under real Wine. On a Windows PC, rcedit itself is used and the shim is not involved.

## Windows and capture

Every opaque classroom window is excluded from capture: the control panel, the main window, roster, messages, devices, the video panel, and the capture-test window. After each BrowserWindow exists, the main process calls `setContentProtection(true)` and checks `isContentProtected()`. Electron runs `SetWindowDisplayAffinity` in this process, which is required: a helper EXE cannot set affinity on an HWND it does not own. The annotation overlay is not protected, so drawings stay in the picture. The region picker is a transparent full-monitor window and is not protected either: excluding a layered window composites as a black rectangle, and the picker closes before the share starts. Capture waits for a desktop composition (`DwmFlush`) after protection is enabled, because the change applies on the next composed frame. The helper executable is only Windows.Graphics.Capture, that flush, and overlay click-through. It does not call `SetWindowDisplayAffinity`.

The toolbar and the other panels are opaque. On Windows 10, a layered or transparent window that is excluded from capture is still composited as a black rectangle, in DXGI and in Windows.Graphics.Capture.

Screen video is the helper’s own Windows.Graphics.Capture of the whole monitor, through `IGraphicsCaptureItemInterop::CreateForMonitor`, a `Direct3D11CaptureFramePool`, and a `GraphicsCaptureSession`. Choosing a window captures the monitor that contains that window, so the annotation overlay is in the frame. Affinity is set first, then `DwmFlush` and a short sleep, then `StartCapture`. The frame pool is created at the published size (at most 1920×1080), which scales on the GPU. If a texture comes back a different size, the helper scales it with the D3D11 video processor and otherwise falls back to a CPU scale. Each frame is read back once and swizzled from BGRA to tightly packed RGBA. The publisher writes those bytes into a `VideoFrame` (`MediaStreamTrackGenerator`) so Chromium encodes them for WebRTC; a canvas is used only when that API is missing. `getDisplayMedia` is not the video path. If Graphics Capture does not start, the share is refused. Nothing is published, and no canvas paints the panels black.

The earlier package did the opposite when WGC failed: it cleared affinity and painted the toolbar and the video panel black into a Chromium capture. That is the black boxes seen on the real Windows 10 PC. This build has no such fallback. `src/renderer/maskTrack.ts` is gone.

System audio is optional and only starts from the Share click. The Chromium video track that comes with that request is stopped and is not published.

## Capture

Share does not wait on an in-app capture test. Sign-in and the timetable no longer offer one. Exclusion of the classroom windows was checked on a Windows desktop: the control panel was absent from the frame, the pixels under it matched, and a red arrow on the unprotected overlay was in the picture. The published share is one 1280×720 stream at 8 fps and about 700 kbps. There is no second simulcast encode. Video mode (the Video button, as on the website) raises the capture to 30 fps and 1.5 Mbps with the `motion` content hint and `maintain-framerate`; it turns on by itself after about 4 s of a full-rate screen (a playing video) and off after 10 s of a quiet one, until the teacher presses Video. Pressing it on also tries to add system (loopback) audio. The teacher camera is 640×360 at 15 fps, with one 320×180 layer for small student screens.

## Shared with the website

`scripts/sync-web.mjs` copies the website's pure modules listed in its `WEB_MODULES` (poll policy, search, video quality and media profile, drawing, whiteboard, realtime packet rules, class finish, time format and more) from `../classroom/apps/web/src/lib` into `src/shared/web/`, and turns the website's `Icons.tsx` into `src/shared/web/icons.ts`. `tests/webSync.test.ts` checks every one of them and fails when a copy drifts; the `Windows teacher app` GitHub workflow runs it against classroom `main` on every push to this branch. Poll intervals (state, chat, waiting), roster / chat search, the share encodings for Video mode and the student-drawing packets therefore come from the same source as the website. Run `node scripts/sync-web.mjs` after changing those web files.

## UI

Look, labels and icons follow the website (same palette, the website's SVG icons, the same words). The dashboard is the website's teacher dashboard: Signed in as, Class live / Rejoin live class, Today (status badges Live, Open now, Opens …, Ended · can reopen, Held / Not held, Covered by …), Coming up, and Ad-hoc class with Campus → Grade (`label (grade)`) → Division checkboxes `grade-label` plus “All divisions of grade X”, free-text extra divisions only before Grades & divisions is set up, and “Max visible student videos”. The request body is the website's (`kind: 'adhoc', campus, grade, divisions, allDivisions, subject`). There are no invite or copy-code buttons.

The meeting screen: a dark stage, Roster and Chat beside it, and a bottom dock of round controls (mic, camera, share, annotate, chat, roster, videos, 2/4/6, Mute all, Unmute all, Leave, End class). The roster and chat are the same React views as the floating windows and the website: “Waiting (n)” block with Admit and All, Mute all / Unmute all, the Waiting room / Direct entry switch, “Search name or SID…”, one-line rows (pen for Drawing / Asks to draw, hand, avatar, name, grade-division, focus chip, Late, icon buttons for mute, pin and lower hand, Allow / Revoke for drawing). Chat has the raised-hands strip, “Search students (name / SID) or messages…” (Enter with one match opens a DM), times, Reply, “To” with `Name · SID`, Back to Everyone and “Private message to X…”. End is hidden while the screen is shared.

Starting a share minimises the main window and opens the floating share controls, laid out like the website's share HUD: Live · mic · camera · student videos · Video | chat · hands · roster · admit (always present, disabled when nobody waits) · annotate | Stop. It snaps to the work-area edges. There is no End on that panel. Stopping the share closes the panel, messages, people, student videos, and the annotation overlay, and brings the main window back. End is available there. Ending the class returns to the timetable.

While sharing, the floating student-video window keeps a face-sized tile, about one sixth of the work-area width, 16:9. On a 1920×1080 work area that is 320×180, so the window is about 648×198 (2), 648×382 (4), or 972×382 (6), including the grip and padding. That window is a same-process child of the class window: camera frames are read with `MediaStreamTrackProcessor` into an `OffscreenCanvas` and the pixels are painted straight into its canvases at 15 fps (JPEG over IPC only as a fallback). A watchdog reopens a stalled reader. See REPORT.md “Frozen student tiles”. The copy is capture-excluded and is not a second screen encode. Tiles rotate about every 8 seconds among students who have a live camera in the server sample, pins and the current speaker first, the same order as the website. Closing the window leaves it closed. On the main meeting screen, before sharing, the same 2/4/6 grid fills the whole left column (1×2, 1×4, and 2×3). Pin is on the tile. A full pin set returns `pins_full`. The camera and microphone buttons publish on the first press and unpublish on the next, so students stop seeing and hearing the teacher when the control is off.

Chat keeps the recipient, has Reply on student messages, and lists raised hands above the composer, earliest first.

Annotate does not freeze the share. The tools are in their own small window, “Annotate tools” (pen, highlighter, line, arrow, rectangle, ellipse, text, laser, eraser, undo / redo, clear, colour swatches and picker, thickness 1–12, and a Draw / Click-through switch). It opens with annotate, sits under the share controls, remembers where it was dragged, and is capture-excluded like the toolbar. Students' drawings (when the teacher allows one to draw) are drawn on the same overlay, so they are in the shared picture too; see REPORT.md “Student drawing on the desktop”. Sharing a screen opens a second, frameless, transparent window over that monitor. Pen, arrow, line, rectangle, ellipse, text, highlight, and eraser are vector shapes on that window, so they are in the monitor capture. The laser is a temporary glow and is not stored. Undo, redo, and clear edit that vector list. The control panel and the tool panel stay capture-excluded and above the overlay, as do the other opaque classroom windows. With annotate off, the overlay is click-through (`setIgnoreMouseEvents` and `WS_EX_TRANSPARENT`) so the application underneath still receives mouse and keyboard. Marks are not published on any data topic (the website's `annotate` topic is gone); they are only in the video. A class share does not also burn those strokes into the published frame. On a normal desktop the overlay is already in the capture, and burning it again drew a second copy on the student screen. The capture-test scorer still burns, because a Remote Desktop session without a GPU left the layered overlay out of the texture. A window choice shares that window’s monitor, so the overlay is part of the captured frame.

## Signaling server

Items 12–14 of the screen-share requirement are: WebRTC to the students, WebSocket signaling, and STUN/TURN. LiveKit is already that system. It is a selective-forwarding unit. Clients speak its WebSocket signaling protocol. It bundles STUN and TURN on the same RTC ports, so a separate TURN deployment is not required. The Windows app joins with the token from `POST /api/rooms/:code/token` and publishes with `livekit-client`. Web students subscribe to the teacher’s screen track through the same room. No second signaling process is started.

Where it is configured (read-only, not copied into this app):

- `/workspace/classroom/infra/livekit.example.yaml` is the template: API port 7880, RTC TCP 7881, UDP 50000–50100, Redis at `127.0.0.1:6379`, `room.auto_create`, and a webhook URL.
- `/workspace/classroom/infra/livekit.yaml` is generated from the server `.env` by `scripts/sync-livekit-keys.sh`. It holds the real API secret. Do not print it, commit it, or paste it into this tree.
- The web app reads `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`. Tokens are minted in `apps/web/src/lib/livekit.ts`. Room events hit `POST /api/livekit/webhook` (CSRF-exempt, signed by LiveKit). That webhook is what force-mutes students while no teacher is connected.

The public classroom the app defaults to is `https://13-201-89-150.sslip.io`. The teacher can type another origin on the sign-in screen. The LiveKit WebSocket URL is whatever that server returns with the token.

## Security, sessions and updates

- Every window loads `app://classroom/…`. Navigation anywhere else is refused, pop-ups are limited to the app's own windows, the preload exposes the bridge only on those pages, and every IPC handler checks that its sender is one of them. Camera, microphone and notification permissions are granted to them only.
- The session cookie is stored encrypted with Windows DPAPI (Electron `safeStorage`). Changing the server address forgets it: a cookie is only ever sent to the server that issued it.
- Teacher sessions slide on the server (24 h without use). The app renews its session every 30 minutes and after the PC wakes.
- Global shortcuts are only registered while a class is open: Ctrl+Alt+Shift+M (microphone), Ctrl+Alt+Shift+V (camera), Ctrl+Alt+Shift+S (stop sharing). The old Ctrl+Shift+M / V / S defaults took paste-as-plain-text and Save as from the apps a teacher shares; untouched old defaults are moved to the new ones on start.
- Updates: the app is not code-signed and has no auto-updater. The school server advertises the current build with `WINDOWS_APP_LATEST`, `WINDOWS_APP_MINIMUM` and `WINDOWS_APP_URL` (`GET /api/desktop/windows`); the dashboard shows "available" or "required" with a Download button. Set a code-signing certificate with electron-builder's `CSC_LINK` / `CSC_KEY_PASSWORD` to sign builds.
- A school build can bake in its server address: `CLASSROOM_DEFAULT_SERVER=https://classes.example.org npm run build`.

## Tests

`npm test` runs the Linux unit tests (capture plan, tile size, chat reply, pixel diff, annotation coordinates at 100/125/150/175/200 percent and on a mixed-DPI monitor pair, undo/redo, remote pixels, waiting room, class logic). `npm run typecheck` is `tsc --noEmit`. Capture exclusion itself cannot be proven under Wine. `TESTING.md` is the procedure for a real Windows 10 or Windows 11 PC. `REPORT.md` says what this machine actually checked.

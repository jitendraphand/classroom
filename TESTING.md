# Testing Classroom Teacher

Two layers. The first runs on this Linux machine. The second is the only check that can show whether students see the desktop under the panels. Wine cannot prove that.

## Automated (Linux)

From `/workspace/windows`:

```
npm test
npm run typecheck
```

`npm test` is `node --import tsx --test tests/*.test.ts`. It covers:

- Capture plan: Windows.Graphics.Capture when the probe says so, otherwise share refused. Affinity stays `0x11`. The mask flag stays false. `shareAllowed` is false unless the mode is `wgc-exclude`.
- Floating video tiles on a 1920×1080 work area: width 320, height 180. Window about 648×198 (2), 648×382 (4), 972×382 (6).
- Published screen capture is one 1280×720 stream at 8 fps, with no simulcast layer. The teacher camera stays at or below 640×360 and 15 fps.
- Chat reply targets and the sticky recipient, including a student who has left.
- Pixel diff used by the capture test (tolerance and pass ratio). It is not wired to any published track.
- Annotation coordinates at 100%, 125%, 150%, 175%, and 200% land on the same 0–1 point. A 150% monitor whose physical origin is not `dipOrigin × 1.5` stays aligned. Remote physical pixels are divided by `screenWidthPx` and `screenHeightPx`. Undo, redo, clear, and eraser restore the vector list. A laser is not stored.
- Waiting-room admit-on-toggle, roster order (hands earliest first), 2/4/6 student cap, pin ordering.
- `webSync`: the copies in `src/shared/web/` are byte-identical to the website's `lib` modules; poll intervals and search match the website.
- `windowProtection`: every window has a documented capture decision that matches `windowShouldBeCaptureExcluded`; only the overlay and region picker are captured; “Annotate tools” is protected before its first show.
- `teacherParity`: dashboard status badges and buttons, campus → grade → divisions and the ad-hoc body, room `desktopInk` / draw fields, Video mode auto-detect, share encodings, student-ink mapping for region shares, thickness.
- `videoMirror`: 15 fps tile gap, tile size, stalled-pump watchdog.

A green run does not mean capture exclusion works. It means the decisions the publisher makes are the ones these tests lock in.

The helper binary is `native/affinity-helper.exe`. It captures with Windows.Graphics.Capture and flushes DWM. It does not call `SetWindowDisplayAffinity`. On Linux, `strings` on that file shows the embedded manifest: supported OS `{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}`, `maxversiontested` `10.0.19041.0`, PerMonitorV2. `probe` under Wine reports Graphics Capture unsupported. That is expected. Content protection is `setContentProtection` / `isContentProtected` on every opaque classroom window. The annotation overlay and the region picker stay unprotected.

## Manual: Windows 10 2004+ and Windows 11

Use a machine on Windows 10 version 2004 or later (build 19041+), or Windows 11. Install `dist/ClassroomTeacher-setup.exe`, or run `dist/ClassroomTeacher-portable.exe`. Do not use an older copy from `release/` left by a previous package if `dist/` has a newer pair. Check the file dates.

Sign in only if you mean to. This account allows one session, so the web app will be signed out.

### 1. Share does not wait on a capture test

Sign-in and the timetable do not offer Capture test. Share starts from the meeting dock. It does not wait for a Notepad run. The picture students receive is one 720p stream at 8 fps.

### 2. A real share, with a student in the web app

Do this outside a scheduled class period so you do not drop students who are auto-joining.

1. Sign in, start the class, admit a student who is in Chrome or Edge on the web app.
2. Press Share. Read the consent line. Nothing is shared until you confirm. Tick **Include system audio** only if you want it. Pick a screen.
3. The main window minimises. The floating control panel opens. Mic, camera, stop share, messages, people, and student videos are on that panel. End is not.
4. On a 1920×1080 display the floating student-video window is about 648×198 (2), 648×382 (4), or 972×382 (6). Tiles show the camera picture, not a blank box, and the set shuffles about every 8 seconds. Closing student videos leaves them closed. Opening them brings the same panel back. Before sharing, the main meeting film fills the left side for 2, 4, and 6.
5. On the student device, the shared screen must show the desktop under the classroom windows. The control panel, people, messages, and video window must be absent when they are open. There must be no black box in their place. Drawings on the overlay must still be visible, once each. Turning the teacher camera or microphone off stops that track for the student. Turning it on starts it again.
6. Drag the control panel across a recognisable window and ask the student to describe that window. They should describe the window, not the panel.
7. Stop share. The control panel, people, messages, student videos, and the annotation overlay close. The main window comes back. End is on that window. The student should return to the camera stage.

System audio: the student should hear the PC, not a second copy of the screen video. If the notice says “Video is sharing. System audio was not included.”, the video path is still the one under test. Audio depends on the Windows display-media prompt and was not verified under Wine.

### 3. Control panel exclusion and annotation

Open Notepad and place the control panel over it before sharing. Share a whole screen. Window capture does not include the overlay.

1. You see Notepad and the control panel.
2. The student sees Notepad only. The pixels that were under the panel are Notepad’s pixels, not a black box and not the panel.
3. Move the panel. The student sees the Notepad pixels change underneath it, and never sees the panel.
4. Turn Annotate on and draw an arrow over Notepad. You see Notepad, the arrow, and the panel. The student sees Notepad and one arrow, not two.
5. Press Clear. The arrow disappears for the student.
6. Turn Annotate off. Click and type in Notepad. Notepad receives both.
7. Repeat the arrow at Windows scale 100%, 125%, 150%, and 200%.
8. On a second monitor, share that monitor and draw. The overlay covers that monitor only.
9. Draw over Chrome, Explorer, and a GPU-accelerated window as well as Notepad.

The capture-exclusion list should show the control panel, main window, videos, roster, and chat as `protected=yes` and excluded. The annotation overlay should show `protected=no` and in the capture. A log line `protected=true` from `isContentProtected()` is the success check. Do not treat a helper `status=null` as an affinity result.

### 4. The rest of the teacher controls

Against one web student, in any order:

- Waiting room on: the student waits. Admit, then Admit all if several are waiting. Waiting room off: people already waiting enter.
- Mute one, Mute all. Unmute only clears the lock. The student still has to press Unmute microphone.
- Raise a hand on the student device. It should lead the roster and the chat strip, earliest first.
- Chat to Everyone, then to that student. After Send, To should stay on that student. Reply on their message should select them. A student who leaves should fall back to Everyone.
- Show 2, 4, and 6. The count includes your tile. Pin a student from the tile. Pinning every student slot should report that the pins are full.
- End class only after sharing has stopped. Confirm “End the class for everyone?”. Back to timetable returns to the home screen. The student should see “Class ended” and Home.

### 5. New in this build (needs a real Windows PC and one web student)

- Student tiles during a share: open Student videos, leave it 5+ minutes; every tile keeps moving (wave at a student camera). Mute/unmute a student camera: the tile recovers within ~3 s.
- Video toggle: play a YouTube video full screen on the shared monitor. Within ~4 s the Video button turns on (“auto”), the student sees smooth motion; stop the video and it turns off after ~10 s. Press Video by hand: auto stops; sound from the PC reaches the student if “Share audio” was not ticked (loopback).
- Student drawing: the student presses Request to draw; the toolbar roster shows a pen dot and a notice. Allow in the roster. The student's strokes appear on your real desktop (over any app), in the student's own view once (not doubled), and fade-free for other students. Revoke and Clear drawing work. Try a Region share: strokes land inside the region.
- Annotate tools: pressing Annotate opens the tool window below the share controls. It must be absent from the student's picture (no black box), while your marks are present. Draw / Click-through switches whether Notepad below takes clicks. Thickness, colour picker, highlighter, undo/redo, clear, close (×) all work. Drag it, stop and restart annotate: it reopens where it was.
- Look: dashboard (campus → grade → divisions), roster and chat match the website's wording and icons; search “name or SID” in both.

## If it fails

The test window prints the log path. It is the Electron user-data file:

`%APPDATA%\Classroom Teacher\capture.log`

Send that file, the Windows version (`winver`: edition and the OS build number), and which step failed (preview, compare, or the student view). Do not send `config.json` from the same folder. It holds the session cookie.

A useful line looks like:

`[capture-test]`
`controlProtected=true`
`captureStartedAt=…`
`firstFrameAt=…`
`frameWidth=…`
`frameHeight=…`

`protected=true` is Electron’s flag. The pass or fail next to the saved PNG files is the frame check. A probe line that says the probe was skipped is not a pass.

A failure to start capture is logged with the helper error. A share that started anyway while the path was unavailable is a bug. A black rectangle while every HWND reads `0x11` and the path is Windows.Graphics.Capture is also a bug. Say whether the panel was the toolbar, the video panel, or both, and whether the window was on a second monitor.

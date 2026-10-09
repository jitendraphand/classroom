# Whole-class simulation — 5 October 2026

Live deployment: `https://13-201-89-150.sslip.io`. Room **S3TDTK**, ad-hoc subject **SIM e2e**, audience **9 (all divisions)**. One Chromium run, 06:17:41Z–06:24:16Z (`results.json` `generatedAt` 2026-10-05T06:24:17.005Z). The class was ended and the browser was closed. No server, deployment, or `/workspace/classroom` code was changed.

Nineteen of the twenty-one recorded steps passed. The two `fail` rows are interpreted below: direct entry succeeded on the server (the script scored the lobby flash), and annotation could not be drawn because the share was an entire-screen capture.

Raw measurements are in `results.json`. Screenshots are under `shots/`. Paths below are relative to `/workspace/windows/e2e-sim/`.

## How it was run

Playwright 1.55 drove system Chrome (channel `chrome`) headless. A fullscreen probe on the HTTPS origin returned `{enabled: true, entered: true}`, so the run stayed headless (`launchMode: headless-chrome-fullscreen-ok`). Fake media flags were `--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`, `--use-file-for-fake-video-capture` = `media/green.y4m` (solid `0x00ff00`, 640×360, 15 fps), and `--use-file-for-fake-audio-capture` = `media/tone.wav` (440 Hz, 10 s).

The teacher signed in as `jitendraphand@gmail.com`. The password was supplied only through `E2E_TEACHER_PASSWORD` and is not in this report, the logs, or the screenshot names. Login attempt 2 returned HTTP 200 and landed on `/teacher/dashboard`. The password-change page did not appear. The dashboard showed **Signed in as Jitendra Phand**.

Students joined with the unsigned school link, last name **Sim**, grade **9**, division **Alpha** (stored as `9-ALPHA`):

| Id | SID | Emulated device | Viewport |
| --- | --- | --- | --- |
| Teacher, W1 | TEST-SIM-W1 | Windows Chrome UA | 1200×720 |
| W2 | TEST-SIM-W2 | Windows Chrome UA | 1100×700 |
| I1, I2 | TEST-SIM-I1, TEST-SIM-I2 | iPhone CriOS UA, `hasTouch` | 390×844, landscape 844×390 |
| A1, A2 | TEST-SIM-A1, TEST-SIM-A2 | Pixel 7 Android Chrome UA, `hasTouch` | 412×915, landscape 915×412 |

`deviceScaleFactor` was 1. All seven contexts shared one Chrome process tree, so CPU is for the tree, not per device.

Chat times on the screenshots read 11:48 AM. That is the browser's local clock (UTC+5:30): 06:18:56Z is 11:48.

## What emulation does not prove

- These are not iPhones, not Android phones, and not WebKit. CriOS and Android strings were set on desktop Chromium. Chromium on this machine has the Fullscreen API, so an iPhone UA never took the iOS Safari "no Fullscreen API / rotate your phone" path.
- `hasTouch` is Playwright's touch flag, not a digitizer. Device scale factor was 1, not 3.
- There is no real GPU. Frames are SwiftShader / software.
- `getDisplayMedia` reported `displaySurface: "monitor"` at 1920×1080. The received pictures are Chrome's animated green test pattern (moving wedge, corner blocks, burned-in timecode), not the classroom tab and not the magenta clip tab. This run cannot prove window or tab capture, screen-share audio, drawing on a preview, or the Windows affinity mask.
- One Chrome tree hosted every context. Per-device CPU cannot be separated.

## Step results

| Time (UTC) | Step | Result | What was measured |
| --- | --- | --- | --- |
| 06:17:41.632 | Fullscreen probe | Pass | Headless Chrome entered fullscreen on the live origin. |
| 06:18:33.346 | 1. Teacher login | Pass | `/teacher/dashboard`. No password-change redirect. |
| 06:18:39.363 | 1. Start class | Pass | S3TDTK, waiting room on, `maxVisibleVideos` 6, 0 admitted, 0 outsiders. Divisions Alpha, Beta, Delta, Gamma. No other live class was displaced (`activeBefore` null). |
| 06:18:45.259 | 2. Four students join | Pass | W1 4380 ms, W2 4378 ms, I1 4597 ms, A1 4539 ms. All four waiting, `viaSchoolApp` true, `9-ALPHA`. |
| 06:18:48.324 | 2. Admit one | Pass | Header button admitted **W1 Sim**. Classroom in 3063 ms. |
| 06:18:50.261 | 2. Admit all | Pass | Waiting list was only TEST-SIM, so Admit all ran. A1 Sim, I1 Sim, W2 Sim. |
| 06:18:55.924 | 2. Admitted state | Pass | Waiting room still on. All four `mutedByTeacher`. Waiting list empty. |
| 06:21:08.872 | 3. Chat | Pass | Six messages. `mismatches` empty. Isolation held. |
| 06:21:14.807 | 4. Hands | Pass | W2 then I1, hand icon before the name. Teacher lowered W2 in 726 ms. |
| 06:21:15.708 | 5. Waiting room off | Pass | Switch reached "Direct entry". `waitingRoomOn` false. Outsiders 0. |
| 06:21:23.777 | 5. I2 and A2 enter | Fail in the script, product pass | Server: both admitted, muted, not waiting. See below. Waiting room turned back on. |
| 06:21:43.969 | 6. Mics | Pass | Locks cleared for all six. One audible inbound sample. Mute all stuck. |
| 06:22:45.487 | 7. Video layouts | Pass | Show 2 / 4 / 6, rotation, no student-to-student video. |
| 06:23:18.205 | 8. Pin | Pass | Roster pin of W1 held through rotation. Second pin at 1 slot returned 409 `pins_full`. |
| 06:23:40.322 | 9. Screen share | Pass | Students received video. Screen-audio inbound was empty on every student. |
| 06:23:43.582 | 10. Annotation | Fail, expected | Annotate stayed disabled. No strokes were sent. Students have no draw control. |
| 06:23:53.417 | 11. Coverage | Pass | black 0% on every device. Overlay 19.5–41.7%. |
| 06:24:02.420 | 12. Fullscreen | Pass | Badge **3 not in fullscreen**. Cover shown on W1, I1, A1. |
| 06:24:09.701 | 13. Roster, invite, leave | Pass | Invite URL copied. W2 left and was readmitted. |
| 06:24:16.382 | 13. End class | Pass | Status ENDED. All six students saw "Class ended". Teacher returned to the dashboard. |
| 06:24:16.672 | Cleanup | Pass | Class ended. Students were not deleted (admin API 401). |

The only confirm dialog was `End class for everyone?` at 06:24:10.058Z, and it was accepted.

### Direct entry (script fail)

The school route always opens `/join/S3TDTK?waiting=1&as=student`, so the page text matches the waiting-room lobby for a moment even after the server has admitted the student. The script returns as soon as it sees that text, and it marked I2 (4260 ms) and A2 (4544 ms) as still waiting.

The teacher state at the same step said both were **admitted**, **mutedByTeacher**, and **not on the waiting list**. The I2 screenshot taken for this step is already the classroom shell ("Connecting to classroom…"): `shots/05-direct/I2.png`. The same is true of `shots/05-direct/A2.png`.

After they were in, the waiting room was turned back on (`waitingRoomRestored: true`, roster switch confirmed). That is a deliberate safety deviation so a real student with the school page open would not walk in. `outsiderCount` stayed 0. Turning the room off had already listed the four previously admitted students under `alsoAdmittedByToggle`; nobody new was waiting at that moment.

### Annotation (expected fail)

`getDisplayMedia` returned one video track, label `screen:-3:0`, `displaySurface: "monitor"`, 1920×1080, 15 fps, `cursor: "never"`. There was no audio track. Constraints captured from the page were `audio: false`, `systemAudio: "exclude"`, `selfBrowserSurface: "exclude"`, `monitorTypeSurfaces: "include"`, video ideal 1920×1080 at 15 fps.

The teacher UI showed **You're sharing your entire screen** and disabled **Annotate** with the title "Drawing needs a window or tab share (an entire-screen share has no preview to draw on)". The script did not inject strokes. Students have no annotate button (`studentAnnotationExists: false`). `canDraw` in the web app is teacher-only, so student drawing was not available to test.

The `shapeCount` of 6–7 on each student page is the small control-icon SVG paths (mic, camera, hand), not annotation strokes. The path data matches those icons.

## Screenshots

Successful-run shots, one set per step. Folders named `06-mic-fail`, `08-pin-fail`, and `13-roster-fail` are leftovers from an earlier aborted attempt the same morning. They are not evidence for this run.

| Step | Files |
| --- | --- |
| Login | `shots/01-login/teacher.png` |
| Start | `shots/01-start/teacher.png` |
| Waiting room | `shots/02-waiting/{teacher,W1,W2,I1,A1}.png` |
| Admitted | `shots/02-admitted/{teacher,W1,W2,I1,A1}.png` |
| Chat | `shots/03-chat/{teacher,W1,W2,I1,A1}.png` |
| Hands | `shots/04-hands/{teacher,W1,W2,I1,A1}.png` |
| Direct entry | `shots/05-direct/{teacher,W1,W2,I1,A1,I2,A2}.png` |
| Mics | `shots/06-mic/{teacher,W1,W2,I1,A1,I2,A2}.png` |
| Layouts | `shots/07-layout/teacher-show-{2,4,6}.png` |
| Video | `shots/07-video/{teacher,W1,W2,I1,A1,I2,A2}.png` |
| Pin | `shots/08-pin/{teacher,W1,W2,I1,A1,I2,A2}.png` |
| Share | `shots/09-share/{teacher,W1,W2,I1,A1,I2,A2}.png`, `shots/09-share/clip-tab.png` |
| Annotate | `shots/10-annotate/{teacher,W1,W2,I1,A1,I2,A2}.png` |
| Coverage | `shots/11-coverage/teacher.png`, `{W1,W2}-portrait.png`, `{I1,I2,A1,A2}-{portrait,landscape}.png` |
| Fullscreen | `shots/12-focus/{teacher,W1,I1,A1}.png` |
| Roster | `shots/13-roster/{teacher,W1,W2,I1,A1,I2,A2}.png` |
| Ended | `shots/13-ended/{teacher,W1,W2,I1,A1,I2,A2}.png`, `shots/13-ended/W1-home.png` |

## Chat

Six messages, scopes checked through each client's `GET /api/rooms/S3TDTK/messages`. `visible` means the body was in the open chat panel. API delivery is the `ms` column (poll until the body appeared). The ~32 s gaps between student replies are the script opening each phone's chat in turn, not network delay.

| Body | Scope | Created | Teacher API | Addressed student | Others |
| --- | --- | --- | --- | --- | --- |
| Hello class SIM-1 | BROADCAST from Jitendra Phand | 06:18:56.331Z | 551 ms, visible | W1 289, W2 298, I1 285, A1 280 ms, panel still closed | all four received it |
| Private note SIM-2 | DIRECT to W1 Sim | 06:18:58.117Z | 552 ms, visible | W1 290 ms | absent from W2, I1, A1 |
| W1 reply SIM-3 | TEACHER | 06:18:59.187Z | 932 ms | W1 288 ms, visible | absent from the other three |
| W2 reply SIM-4 | TEACHER | 06:19:31.052Z | 349 ms | W2 298 ms, visible | absent from the others |
| I1 reply SIM-5 | TEACHER | 06:20:02.349Z | 983 ms | I1 286 ms, visible | absent from the others |
| A1 reply SIM-6 | TEACHER | 06:20:34.705Z | 338 ms | A1 282 ms, visible | absent from the others |

Final views: the teacher had all six. W1 had the broadcast, the DM, and their own reply. W2, I1, and A1 each had the broadcast and their own reply only.

Chat composer box (the panel was open):

| Device | Viewport | Composer |
| --- | --- | --- |
| W1 | 1200×720 | 298×75 at (871, 494), right side |
| W2 | 1100×700 | 298×75 at (771, 474), right side |
| I1 | 390×844 | 298×75 at (61, 618), nearly full width |
| A1 | 412×915 | 298×75 at (83, 689), nearly full width |

Students only had the destination **To teacher**. The teacher DM row is badged **DM** and names W1 Sim (`shots/03-chat/W1.png`, `shots/11-coverage/W1-portrait.png`).

## Hands

W2 raised at server time, visible to the teacher in **412 ms**. I1 raised about 1.6 s later, visible in **416 ms**. Roster order while both were up: W2 Sim, I1 Sim, then A1 Sim, W1 Sim. The hand icon (`aria-label="Hand raised"`) sat before the name on both. The teacher lowered W2 in **726 ms**. I1 was left raised on purpose and was still first in the roster at step 13, with chips `9-ALPHA` and `Left fullscreen`.

## Audio

Students joined `mutedByTeacher: true`. The script clicked the teacher's **Mute microphone** when that button was present. That click was not given its own assertion.

- Unlocking W1 alone cleared `mutedByTeacher` in **679 ms**. The page text captured immediately afterwards still contained "Muted by teacher — wait to be unmuted", so the script did not click a local unmute on W1. This was a page-text snapshot, not a second read of the button, so it is weak evidence of a stuck label.
- **Unmute all** is the product control that clears the teacher lock. It does not turn the local mic on. After it, every one of the six students had `mutedByTeacher: false`, and W2's button changed from disabled **Muted by teacher** to enabled **Unmute microphone**.
- W2 then clicked **Unmute microphone**. W2's next getStats sample had one inbound audio track: **24 kbps**, `audioLevel` 0.0117, `totalAudioEnergy` 0.00260. That is the only inbound audio with energy above 0 in the whole run. Because the teacher-mute click was not verified, this sample is not a clean proof of student-to-student hearing. It does show that an audio track was flowing to a student who had been allowed to unmute.
- The sample taken right after the W1 unlock, before any local unmute, had empty inbound and outbound RTP on W2, I1, A1, and the teacher (connections were still settling).
- **Mute all** completed in **5217 ms**. `allMuted` was true. Two samples on I1 both had inbound energy 0 (`energyDelta` 0).

Screen-share audio, measured while video was arriving: inbound audio arrays were empty and inbound energy was 0 for W1, W2, I1, A1, I2, and A2. The capture constraints had `audio: false` and `systemAudio: "exclude"`. A second teacher tab played `tone.wav` and painted a magenta canvas labelled SIM-CLIP (`shots/09-share/clip-tab.png`). Fake display capture did not publish that tab.

## Video, layouts, pinning

Student cameras were already on (each button read **Turn camera off**). Teacher tiles of those cameras are the bright green fake picture (`shots/07-layout/teacher-show-6.png`).

The layout buttons are titled "Show N videos, including you". The click sends `maxVisibleVideos = N − 1` student slots. Observed:

| Control | `maxVisibleVideos` | Students marked visible |
| --- | --- | --- |
| Show 2 videos | 1 | A1 Sim |
| Show 4 videos | 3 | A1 Sim, I1 Sim, I2 Sim |
| Show 6 videos | 5 | W1 Sim, A1 Sim, W2 Sim, I2 Sim, A2 Sim |

Header at Show 6: **5/5 videos shown · 6 students**. With six students, one is always outside a 5-slot panel. The dashboard cap had been set to 6, which is the product maximum.

At one student slot, samples about every 4.3 s for 40 s showed, in order: W1 (0.7 s and 5 s), I2 (9 s and 14 s), A1 (18 s through 31 s, four samples), I1 (35 s and 40 s). Distinct names: W1, I2, A1, I1. W2 and A2 did not appear in that 40 s window. The script had unmuted W1 so the fake tone could act as an active speaker; W1 did occupy the first two samples. Speaker priority beyond that was not isolated, because later slots moved on to I2, A1, and I1 while W1 stayed quiet in the panel.

Teacher inbound during this phase: one video, **320×180 @ 15 fps, ~5 kbps**, `rid` null. That is a camera tile, taken before the screen share.

Privacy, every student, connection `connected` / ICE `connected`:

- Inbound video tracks: **none**.
- Video elements: one, `aria` **Your camera**, 320×180.
- Outbound video mostly 0 kbps with a null resolution (unused simulcast encodings, `qualityLimitationReason: "none"`). I1 had one outbound at 320×180 @ 15 fps, ~5 kbps. No `rid` was present on any sample.

Pinning used the roster button **Pin W1 Sim's video** after Show 4. No tile button whose label contains "keep in the panel" was in the accessibility tree (`tileLabels` empty), so pin-from-tile was not confirmed. W1 stayed pinned across three rotation samples ~8 s apart while the other slots changed:

| Time | Visible | Pinned |
| --- | --- | --- |
| 06:22:56.588 | W1, I1, W2 | W1 |
| 06:23:04.884 | W1, W2, I2 | W1 |
| 06:23:13.183 | W1, I2, A2 | W1 |

The script then unpinned from the roster, switched to Show 2 (1 student slot), pinned W1 again, and pinned A1. `POST /api/rooms/S3TDTK/pin-student` at 06:23:15.604Z returned **409**:

```json
{"error":"All 1 video slots are pinned. Unpin a student or show more videos first.","reason":"pins_full","max":1}
```

Pinned set stayed `[W1 Sim]`, `maxVisibleVideos` 1. The same sentence appeared in the teacher banner, next to **1/1 videos shown · 6 students** (`shots/08-pin/teacher.png`, and still visible on the share shots). Three later `pin-student` responses at 06:24:16.835Z were HTTP 200 with an empty body, at class-end time.

Screen-share getStats, about 16.6 s after the share click. `rid` null on every row. MIME was not filled in by the sampler.

| Student | Inbound video | Bitrate | Inbound screen audio |
| --- | --- | --- | --- |
| W1 | 1280×720 @ 10 fps | 247 kbps | none |
| W2 | 1280×720 @ 10 fps | 255 kbps | none |
| I1 | 1920×1080 @ 15 fps | 662 kbps | none |
| A1 | 1920×1080 @ 14 fps | 597 kbps | none |
| I2 | 1920×1080 @ 15 fps | 587 kbps | none |
| A2 | 1920×1080 @ 15 fps | 662 kbps | none |

W1 also had an outbound camera at 320×180 @ 15 fps, ~5 kbps, during the share. Desktop students received a 720p layer; the four phones received 1080p. Nothing in getStats named a simulcast `rid`.

## Blackout and overlay

`blackPct` and `greenPct` are of the largest decoded `<video>` (the received share), sampled by drawing it to a 160-px-wide canvas. A pixel is black when r, g, and b are all below 18. A pixel is green when g > 160 and r and b are both below 90. `overlayPct` is the union, on a 48×48 grid, of `.stage-float-chrome`, `[aria-label="Teacher camera"]`, `.stage-fullscreen-badge`, `[aria-label="Tap to return to fullscreen"]`, `.control-float`, and `.student-media-tile`. The open chat sheet is **not** in that set. Chat was still open in these screenshots and covers most of a phone, so the visual occlusion is larger than `overlayPct`.

The teacher share HUD said: "The floating controls were closed because their position on the shared screen could not be tracked. They are here in this tab instead." The received frames therefore contain no toolbar mask. `blackPct` is 0 everywhere. The bright-green percentage stays in the 6–13% range because most of the animated pattern is a darker green that misses the threshold; the screenshots themselves are predominantly green (`shots/09-share/W1.png`, `shots/11-coverage/W1-portrait.png`).

| Device | Orientation | Frame | Black | Bright green | Overlay | Shot |
| --- | --- | --- | --- | --- | --- | --- |
| W1 | 1200×720 | 1280×720 | 0% | 10.0% | 21.0% | `shots/11-coverage/W1-portrait.png` |
| W2 | 1100×700 | 1280×720 | 0% | 6.6% | 21.2% | `shots/11-coverage/W2-portrait.png` |
| I1 | portrait 390×844 | 1920×1080 | 0% | 12.3% | 22.5% | `shots/11-coverage/I1-portrait.png` |
| I1 | landscape 844×390 | 1280×720 | 0% | 9.3% | 41.7% | `shots/11-coverage/I1-landscape.png` |
| I2 | portrait 390×844 | 1920×1080 | 0% | 6.2% | 22.5% | `shots/11-coverage/I2-portrait.png` |
| I2 | landscape 844×390 | 1280×720 | 0% | 9.5% | 41.7% | `shots/11-coverage/I2-landscape.png` |
| A1 | portrait 412×915 | 1920×1080 | 0% | 13.2% | 19.5% | `shots/11-coverage/A1-portrait.png` |
| A1 | landscape 915×412 | 1920×1080 | 0% | 10.1% | 38.7% | `shots/11-coverage/A1-landscape.png` |
| A2 | portrait 412×915 | 1920×1080 | 0% | 6.1% | 19.5% | `shots/11-coverage/A2-portrait.png` |
| A2 | landscape 915×412 | 1920×1080 | 0% | 13.2% | 38.7% | `shots/11-coverage/A2-landscape.png` |

Chrome that was counted, same on both phones of a size:

- Desktop: a 136-px-tall bottom chrome bar across the full width, a 112×30 "Teacher screen" badge at (12, 12), a 480×92 control pill, and a 168×95 self-view tile.
- iPhone portrait: bottom chrome 390×136, controls 366×92, self-view 164×92. Landscape: the same 136-px chrome on a 390-px-tall viewport, which is why overlay jumps to **41.7%**.
- Pixel 7 portrait: bottom chrome 412×136, overlay **19.5%**. Landscape overlay **38.7%**.

`shots/11-coverage/teacher.png` is the teacher side during the same window: entire-screen card, Annotate disabled, controls pulled into the tab.

## Fullscreen

W1, I1, and A1 were already in fullscreen (`fullscreenEnabled` true, `already: true`) from the student-ready helper. Each then left fullscreen. All three showed the cover **Tap to return to fullscreen**, with the copy "You are still in the class and can hear it. Your teacher can see that you left fullscreen." `rotate` was false. The cover text also included the chat transcript line "Everyone 11:48 AM Hello class SIM-1".

Teacher badge: **3 not in fullscreen** (`shots/12-focus/teacher.png`).

| Student | Focus | `focusIphone` |
| --- | --- | --- |
| W1 Sim | left | false |
| A1 Sim | left | false |
| I1 Sim | left | true |
| W2 Sim | fullscreen | false |
| I2 Sim | fullscreen | true |
| A2 Sim | fullscreen | false |

`focusIphone` is true for the CriOS contexts even when I2 was still fullscreen. It tracks the iPhone user agent, not "has left fullscreen". The badge counted the three `left` rows.

## Roster, invite, leave, end

After the fullscreen exits, roster chips were:

- I1 Sim — hand raised, `9-ALPHA`, `Left fullscreen` (hand icon before the name)
- A1 Sim, W1 Sim — `9-ALPHA`, `Left fullscreen`
- A2 Sim, I2 Sim, W2 Sim — `9-ALPHA`
- Outsider rows: 0

**Copy invite link** wrote `https://13-201-89-150.sslip.io/join/S3TDTK` (`clipError` null). Device switch was not exercised.

W2 **Leave class** reached `https://13-201-89-150.sslip.io/` in **642 ms** (Staff login / Student? Join a class). Rejoin looked like the lobby again at 2144 ms (same waiting-room flash). Readmit succeeded in **1614 ms**, href `/classroom/S3TDTK`, text "Waiting for teacher…" and "Muted by teacher".

End class: room status **ENDED**, teacher href `/teacher/dashboard`. All six students, still on `/classroom/S3TDTK`, showed "Class ended. Your teacher has ended this class. You can leave this page." W1's **Home** then went to `https://13-201-89-150.sslip.io/` (`shots/13-ended/W1-home.png`), the guest landing page. The teacher dashboard after end still showed the signed-in teacher, Monday Oct 5, and the timetable note that the waiting room opens 10 minutes before class.

## CPU and join time

`cpuCores` is the Chrome tree's user+system time since the previous sample, as a fraction of one core. RSS is the tree.

| Sample | Processes | RSS | Cores since previous |
| --- | --- | --- | --- |
| 06:18:34 before class | 9 | 1051 MB | — |
| 06:21:43 after mics | 23 | 3657 MB | 1.47 |
| 06:22:43 during video | 23 | 3676 MB | 1.39 |
| 06:23:36 during share | 24 | 4450 MB | 1.78 |
| 06:24:16 after end | 23 | 3742 MB | 1.68 |

Peak RSS was **4450 MB** during the share. Join-to-lobby times were 4.3–4.6 s. Admit-to-classroom for W1 was 3.1 s. W2's leave was 0.6 s and the readmit 1.6 s.

Console noise: the teacher page logged the intentional **409** (pins full) and a **401** from the admin-students probe. Each student logged LiveKit "User-Initiated Abort" / publisher data-channel closed on room `classroom_S3TDTK_396b0e2bbefc488a` (`RM_epxs2HP5KFzd`) as the room disconnected. Those lines sit at teardown.

## Bugs and product findings

Ranked by how much they break the class. Nothing here was fixed.

1. **High — shared-tab audio is never captured.** `captureScreen()` calls `getDisplayMedia` with `audio: false` and `systemAudio: 'exclude'` (`ClassroomRoom.tsx`). The live track list had video only. All six students had empty screen-audio inbound while their screen-video inbound was 247–662 kbps. Repro: start a class, share a tab that is playing audio, watch student `getStats` inbound audio. A clip tab in the same context is not enough; the capture hard-codes the exclusion before the browser can offer system audio.

2. **High — entire-screen share cannot be annotated, and students cannot draw.** On this capture the Annotate button was disabled with "Drawing needs a window or tab share (an entire-screen share has no preview to draw on)". Zero strokes arrived. Student pages have no annotate control; drawing is teacher-only. Repro: share an entire screen (or any capture that reports `displaySurface: "monitor"`), open Share controls, observe Annotate disabled. A window or tab share was not reachable here because fake `getDisplayMedia` reports a monitor.

3. **Medium — school-app Home after "Class ended" opened the guest page.** The server listed every TEST-SIM student as `viaSchoolApp: true` and `9-ALPHA`. W1's Home button on the class-ended screen navigated to `/` (Staff login / Student? Join a class) instead of `/student`. `goHomeAfterEnd` sends school students to `/student` when `schoolStudent` is true, and `schoolStudent` is set from `state.me.viaSchoolApp`. The fallback `GET /api/student/check` runs only when that flag is still null. Repro: join through `/join?FirstName&LastName&SID&Grade&Division`, get admitted, end the class, click Home. Separately, **Leave class** always sends a non-teacher to `/` (`leave()` pushes `/`). That matches W2's 642 ms exit and is a different control from Home.

4. **Medium — the lobby paints a nameless waiting room before the student record arrives.** Join-time text for W2, I1, A1, I2, and A2 was "Hi — you're in the lobby for S3TDTK" plus "Not you? Join with a different name", while the teacher API already had the display name, `viaSchoolApp`, and `9-ALPHA`. W1's first text already said "Hi, W1 Sim" and "SIM e2e · 9 (all divisions)". Later screenshots, including `shots/02-waiting/W2.png`, show the real name and subject, so this is a first-paint race. The same flash made the direct-entry check look like a waiting room. The waiting-room branch does not switch to "This class has ended"; that sentence is on the manual join form. In this run everyone was inside `/classroom/S3TDTK` at End, and they all saw "Class ended" there.

5. **Low — single-student unmute was slow to show on the student page.** The server cleared W1's lock in 679 ms, and the text grabbed at that moment still said "Muted by teacher — wait to be unmuted". **Unmute all** did update W2's button immediately to an enabled **Unmute microphone**. "Unmute all" clears the lock and does not enable the local mic; the student has to click Unmute. That part matches the control's behaviour.

6. **Low — tile pin control was absent.** After a successful roster pin, no button labelled "keep in the panel" existed, so pinning from a tile could not be checked. Roster pin, rotation hold, and the 409 cap all worked.

Not a bug: Show 6 displaying five students. The button title is "Show 6 videos, including you", and the header read 5/5. Not a bug: I1's hand still up at the end. Only W2's hand was lowered.

The 0% blackout is a property of this host. The web app closed the floating controls because it could not track their position on the shared screen, and it said so in the share HUD. The Windows affinity mask was not part of this web run.

## UX by device

**Windows Chrome (teacher, W1, W2).** The stage, a right-hand chat sheet about 300 px wide, and the bottom control pill fit together at 1100–1200 px. Chat leaves the shared picture readable. The self-view sits above the controls, clear of the chat. The teacher roster is a right-hand panel with Mute all, Unmute all, and the Waiting room switch; opening it is a header or dock "Roster" / "Open roster" control. During the share the teacher sees the entire-screen card instead of a drawable preview, and the share controls sit in a bottom "Share controls" tray because the float could not be tracked.

**iPhone CriOS, emulated, 390×844.** The chat sheet is 298 px wide, so it covers almost the whole stage and sits on top of the self-view (`shots/03-chat/I1.png`, `shots/11-coverage/I1-portrait.png`). The control pill stretches to 366 px and shares the bottom with a 136 px chrome bar. In landscape that bar is about 42% of the 390 px height, and the 16:9 share is letterboxed around it. The fullscreen cover, when shown, is a full-viewport button and blocks the controls until it is tapped. The CriOS UA did get `focusIphone: true`. It also got a real Fullscreen API, so the "rotate your phone" cover never appeared.

**Pixel 7, emulated, 412×915.** Same pattern as the iPhone with a little more side margin. Portrait overlay of the chrome (chat excluded) was the smallest of the phones at 19.5%. Landscape rose to 38.7% because the 136 px bar and the 92 px control pill stack on a 412 px height. Chat again spans nearly the full width. Android UA students stayed `focusIphone: false`.

On every student device the pre-share stage says the teacher is in the room and that their screen will fill the view when shared. Once the share is up, a **Teacher screen** badge sits at the top left. Students never saw another student's camera; the only extra picture was their own "Your camera" tile.

## Cleanup

The class status is **ENDED**. No TEST-SIM browser is still running.

This teacher session cannot delete students. `GET /api/admin/students` from the teacher cookie returned **HTTP 401** (`keys: ["error"]`). The route is GET-only. These records are left for manual cleanup:

| SID | Name | Grade | Division | Room | Subject |
| --- | --- | --- | --- | --- | --- |
| TEST-SIM-W1 | W1 Sim | 9 | ALPHA | S3TDTK | SIM e2e |
| TEST-SIM-W2 | W2 Sim | 9 | ALPHA | S3TDTK | SIM e2e |
| TEST-SIM-I1 | I1 Sim | 9 | ALPHA | S3TDTK | SIM e2e |
| TEST-SIM-I2 | I2 Sim | 9 | ALPHA | S3TDTK | SIM e2e |
| TEST-SIM-A1 | A1 Sim | 9 | ALPHA | S3TDTK | SIM e2e |
| TEST-SIM-A2 | A2 Sim | 9 | ALPHA | S3TDTK | SIM e2e |

An earlier aborted attempt the same morning also started an ad-hoc **SIM e2e** on S3TDTK and ended it before anyone was admitted. That attempt upserted TEST-SIM-W1, W2, I1, and A1 only. I2 and A2 exist from this run. Attendance and session rows for both ended sessions need a manual delete; this account could not remove them.

No real student was admitted, muted, or messaged. Admit all ran only while the waiting list was exclusively TEST-SIM names.

## Repeating the run

```bash
cd /workspace/windows/e2e-sim
E2E_TEACHER_PASSWORD='…' node run.mjs
```

The script reads the password from the environment only. It regenerates `media/green.y4m` and `media/tone.wav` if they are missing, writes `results.json` and `shots/`, ends the class in a `finally` block, and closes the browser. Logging in signs the teacher's other session out. Starting the ad-hoc class ends any other room this teacher already has running.

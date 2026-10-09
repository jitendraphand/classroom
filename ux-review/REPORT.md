# Live-class UX review — 5 October 2026

Review of the deployed classroom at `https://13-201-89-150.sslip.io`. One live session, room **S3TDTK**, subject **REV ux**, audience **9 (all divisions)**. Started 2026-10-05T15:41:06Z, class status **ENDED** at 15:46:20Z, results written 15:46:21.337Z. Script: `run.mjs`. Measurements: `results.json`. Screenshots below are relative to this folder.

The class was not started again. A scheduled Physics period (03:40–04:20 PM on the student clock, timezone UTC) was still open when the run finished, and school-app students on `/student` are told they will enter automatically. A second ad-hoc class would have put that period’s real students into a waiting room.

## How to read this

Eleven Chromium contexts, one Chrome process tree, `channel: chrome`, headless. Launch mode `headless-chrome-fullscreen-ok`: a probe on the HTTPS origin entered fullscreen. Fake camera, mic, and display (`--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`, `media/green.y4m`, `media/tone.wav`). `deviceScaleFactor` 1. Timezone UTC, locale en-US, so the chat clock reads 03:42 PM at 15:42 UTC.

These are emulated Chromium clients with device metrics and user-agent strings. They do not prove:

- iOS Safari / WebKit fullscreen, audio session, or the CriOS-without-Fullscreen-API path. This Chrome build exposed the Fullscreen API to the iPhone user-agent, and the pages did enter fullscreen.
- Real touch, real hit targets at device pixel ratio 3, or a real GPU compositor.
- Real Android Chrome hardware, orientation lock, or system permission sheets.
- That a human can hear the magenta clip tab. Capture came back as a **monitor** (`displaySurface: "monitor"`, `screen:-3:0`), and the audio track is labeled **Fake audio** because of the fake-device flag.

Teacher account signed in as jitendraphand@gmail.com. The classroom shows **Jitendra Phand** / **JP**. No other real student was waiting or admitted (`outsiderCount` 0 throughout). The first login POST returned HTTP 400 `Invalid email`; the retry returned HTTP 200 and landed on `/teacher/dashboard`. No password-change redirect.

Peak Chrome RSS (one tree, per-device CPU not separable): start 1031 MB / 9 processes; video panel 5423 MB / 31 processes / ~2.03 cores; share 6288 MB / 32 processes / ~2.42 cores; end 5469 MB / 32 processes / ~2.98 cores. Chrome was gone after the run.

| Id | Family | Viewport | Role |
| --- | --- | --- | --- |
| Teacher | Windows Chrome | 1400×860 | signed-in teacher |
| WD1, WD2 | Windows Chrome | 1366×768, 1280×800 | students |
| AP1, AP2 | Android Chrome phone | 412×915 (landscape 915×412) | students |
| AT1, AT2 | Android Chrome tablet | 1280×800 (portrait 800×1280) | students |
| IP1, IP2 | iOS Chrome iPhone | 390×844 (landscape 844×390) | students |
| ID1, ID2 | iOS Chrome iPad | 1180×820 (portrait 820×1180) | ID2 joined late |

All ten students: last name Rev, grade 9, division Alpha, `gradeDivision` **9-ALPHA**, `viaSchoolApp` true. Display names are `WD1 Rev` and so on.

## A. Chat

### 1. Visible strings — pass

Empty teacher panel (`shots/03-chat-empty/teacher.png`), 320×420 at (1060, 320) on 1400×860, **11.2%** of the viewport:

> No messages yet
> Broadcast to everyone or DM a student.
> To
> Everyone

The To list also contained, in order: WD1 Rev, AP1 Rev, WD2 Rev, AP2 Rev, AT1 Rev, AT2 Rev, ID1 Rev, IP2 Rev, IP1 Rev. Placeholder **Write a message…**. Send control accessible name **Send message**, disabled while the field is empty. Selected value **Everyone**.

Empty student panel, every measured family:

> No messages yet
> Say hello to your teacher.
> To teacher

Students have no To `<select>` (`toOptions` length 0). Same placeholder and the same disabled **Send message** button.

After messages, each row shows avatar initials, the sender’s display name, a scope badge, the time, and the body. Exact badges from the live thread:

- Broadcast: **Everyone**
- Teacher to one student: **DM** and **→ WD1 Rev** (or **→ IP1 Rev**)
- Student to teacher: **To teacher**

Times rendered as **03:42 PM** and **03:43 PM**. Teacher initials **JP**, name **Jitendra Phand**. Student initials match the display name (WR, AR, IR). Panel chrome is **Chat**, a minimize control, and **✕**.

Unread: with chat closed, the **Open chat** button (44×44) showed the text **1** on WD1, AP1, AT1, IP1, and ID1. Opening chat renamed the button **Close chat** and cleared the badge. The count is the button’s text, not its accessible name.

No send error appeared. The class never produced “Class has ended”, “Send failed”, or “Network error” while it was live. After end, students left the classroom page (question 18), so the closed-chat empty state was not what they were left looking at.

Teacher mixed thread, captured while chat was open during the hand-raise section (`shots/03-chat/teacher.png` is a later slice of the same panel):

> JP / Jitendra Phand / Everyone / 03:42 PM / Unread ping REV-U
> JP / Jitendra Phand / Everyone / 03:42 PM / Hello class REV-1
> JP / Jitendra Phand / DM / → WD1 Rev / 03:42 PM / Private note REV-2
> JP / Jitendra Phand / DM / → IP1 Rev / 03:42 PM / Second DM REV-3
> WR / WD1 Rev / To teacher / 03:42 PM / WD1 reply REV-4
> AR / AP1 Rev / To teacher / 03:42 PM / AP1 reply REV-5
> AR / AT1 Rev / To teacher / 03:43 PM / AT1 reply REV-6

ID1’s “To teacher” line, the DM “Reply to WD1 REV-9”, and the broadcast “Reply to everyone REV-10” are on `shots/03-chat/teacher.png`.

### 2. The teacher sees every message — pass

Final API view for the teacher, 11 messages: REV-U and REV-1 broadcast, REV-2 direct to WD1 Rev, REV-3 direct to IP1 Rev, REV-4 through REV-8 student-to-teacher, REV-9 direct to WD1 Rev, REV-10 broadcast.

Isolation held. Each student received only broadcasts, their own notes to the teacher, and directs addressed to them:

| Viewer | Bodies they received |
| --- | --- |
| Teacher | REV-U, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 |
| WD1 Rev | REV-U, 1, 2, 4, 9, 10 |
| WD2 Rev | REV-U, 1, 10 |
| AP1 Rev | REV-U, 1, 5, 10 |
| AT1 Rev | REV-U, 1, 6, 10 |
| IP1 Rev | REV-U, 1, 3, 7, 10 |
| ID1 Rev | REV-U, 1, 8, 10 |

WD2 did not receive the DM to WD1. WD1 did not receive the DM to IP1. AP1 did not receive WD1’s note to the teacher. `visible: false` in the latency table means that client’s panel was closed, not that the message leaked.

### 3. Replying to one student — pass, with a fixed extra step

There is no per-message Reply. The teacher replies by choosing a name in the **To** select at the bottom of the chat panel, typing, and pressing **Send message**.

Exact path used for “Reply to WD1 REV-9”:

1. Open chat from the dock (**Open chat**). Opening chat closes the roster.
2. Change **To** from **Everyone** to **WD1 Rev**.
3. Type and send.

That was 3 clicks and 612 ms of composer work, chat having been closed. A direct to WD1 Rev with chat already open (“Private note REV-2”) was 2 clicks and 136 ms. A second direct, to IP1 Rev, was 2 clicks and 98 ms.

After each successful direct, the select snapped back to **Everyone** (`afterDmSelect` and `afterDm2Select` are both `Everyone`). The next private reply has to re-select the student. The following broadcast can be type-and-send.

Switching the other way is the same control: open the **To** list and pick **Everyone**. “Reply to everyone REV-10” was sent with chat already open, 2 clicks, 988 ms. The script re-selected **Everyone** even though the field had already reset, so one of those two clicks is the script, not a required gesture. With chat open and To already on Everyone, a broadcast is type and send.

Students never pick a recipient. Their composer always reads **To teacher**. One click sends when the panel is already open (WD1’s reply, 98 ms).

### 4. Convenience — measured

| Action | Chat state | Clicks | Composer time | Arrived at the teacher |
| --- | --- | --- | --- | --- |
| Broadcast “Hello class REV-1” | had to open | 2 | 490 ms | 577 ms, panel open |
| Direct to WD1 Rev | already open | 2 | 136 ms | 576 ms |
| Direct to IP1 Rev | already open | 2 | 98 ms | 578 ms |
| Reply to WD1 Rev | had to open | 3 | 612 ms | (API row REV-9, teacher view) |
| Reply to everyone | already open | 2 | 988 ms | (API row REV-10) |
| Student → teacher, panel open | already open | 1 | 98 ms | 326 ms (WD1) |
| Student → teacher, panel closed | had to open | 2 | 494–554 ms | 297–883 ms |

Delivery of the broadcast, client poll: IP1 321 ms, ID1 322 ms, AT1 552 ms, AP1 872 ms, WD1 886 ms. Direct to WD1 reached that student in 928 ms. Direct to IP1 reached IP1 in 855 ms (panel closed). Student notes reached the teacher in 297–883 ms. Nothing in this set was slow enough to feel broken. The friction is the recipient, not the network.

What gets in the way:

- The recipient does not stick. A private answer resets **To** to **Everyone**, so a second private line to the same student is another selection.
- There is nothing to tap on the message itself.
- Send and the chat toggle are 44×44. That is a comfortable tap on the phones we emulated. Phone landscape uses a side rail; the measured chat and mic controls in this run were still 44×44.
- While the teacher’s chat is open, the roster is closed. Raised hands are not drawn in the composer. `handLabels` was 0 and the roster badge text was empty (that badge is the waiting count, and nobody was waiting). The unread **1** sits on the closed **Open chat** button and disappears once the thread is open, so it does not stay beside the composer.
- On a portrait phone the sheet itself is the friction: see question 5.

### 5. Student chat on every family — pass

Before share, chat open:

| Family | Viewport | Form | Box | Cover |
| --- | --- | --- | --- | --- |
| WD1 Windows | 1366×768 | floating panel | 320×420 at (1026, 208) | 12.8% |
| AP1 Android phone | 412×915 | bottom sheet | 396×458 at (8, 337) | 48.1% |
| AT1 Android tablet | 1280×800 | floating panel | 320×420 at (940, 240) | 13.1% |
| IP1 iPhone | 390×844 | bottom sheet | 374×422 at (8, 302) | 47.9% |
| ID1 iPad | 1180×820 | floating panel | 320×420 at (840, 260) | 13.9% |

Tablets and the iPad are wider than 640 px, in portrait as well as landscape, so they get the desktop panel. Android tablet portrait is 800×1280 and the sheet is still 320×420 (**13.1%**). iPad portrait is 820×1180, same panel (**13.9%**).

During share the same boxes came back, and the thread was readable inside them, including “Hello class REV-1” and “Reply to everyone REV-10”. Teacher chat during share is a smaller panel inside the share HUD: 420×220, **7.7%** of 1400×860, still showing the To list through ID2 Rev. Shots: `shots/12-chat-during-share/`.

During annotate the student panels were still open, so the phone shots show the sheet on top of the drawing (`shots/13-annotate/AP1.png`, `shots/13-annotate/IP1.png`). The message text is readable. On those portrait frames the sheet covers the middle of the shared picture; the X is confirmed visually where the stage is not covered (teacher and WD1).

Phone landscape during share, chat open: AP1 sheet 360×396, chat cover **37.8%**, union of all chrome **41.5%**. IP1 sheet 360×374, chat cover **40.9%**, union **45.7%**. Landscape does not turn the sheet into a slim column.

## B. Screen share and annotation

### 6. Whole-screen share — pass, as a monitor share

From the teacher Windows context the live capture was an entire screen, 8420 ms from the click to a track.

Live copy on `shots/10-share/teacher.png`:

> You're sharing your entire screen
> Students see your screen live. The preview is hidden here so it is not captured again (an endless tunnel). Minimise this window or switch to what you want to show. Share a window or a tab instead to see a live preview and draw on it.
> Stop sharing

Also on that screen: **Stage · Screen**, **Waiting room on: you admit each student. Dismiss**, a **Share controls** strip with **LIVE**, **Annotate**, **Stop**, and:

> The floating controls were closed because their position on the shared screen could not be tracked. They are here in this tab instead.

`getDisplayMedia` constraints actually used: video ideal 1920×1080, frameRate ideal 15 max 15, `systemAudio: "include"`, `monitorTypeSurfaces: "include"`, `selfBrowserSurface: "exclude"`, plus an audio constraint object. Tracks returned:

- video, label `screen:-3:0`, `displaySurface: "monitor"`, 1920×1080, 15 fps, cursor never
- audio, label **Fake audio**, 2 channels, 44100 Hz

A clip tab with a tone was opened so tab audio could be checked. The fake display picker shared the monitor, so this run did not exercise “share this tab”. Students still received one inbound audio stream at about **48 kbps**, audio level about **0.090**. That level is the fake-device tone, not a proven recording of the clip tab.

Inbound video of the share, sampled on five families (a second 320×180 stream at ~5 kbps and 15 fps is the teacher camera):

| Student | Share frame | fps | Bitrate |
| --- | --- | --- | --- |
| WD1 | 1280×720 | 11 | not available on that sample |
| AT1 | 1280×720 | 10 | 240 kbps |
| AP1 | 1920×1080 | 15 | 675 kbps |
| IP1 | 1920×1080 | 15 | 590 kbps |
| ID1 | 1920×1080 | 15 | 588 kbps |

WD1 and AT1 were downscaled relative to the published 1920×1080. AP1, IP1, and ID1 received the full frame.

### 7. Floating teacher video and self-view — pass on every family

Present on Windows, Android phone, Android tablet, iPhone, and iPad, before share and again during share. Accessible name **Videos — drag the top bar to move**. Expanded size about **182×232** (iPhone portrait **178×227**). Both tiles present once the teacher camera was on: **Teacher camera** / **Jitendra Phand**, and **Your camera** / the student’s own name. Buttons on the expanded card: **Minimize**, **Min**, **Hide**.

Drag, top bar, before share (the panel also stops at the left edge):

| Family | Before | After | Delta |
| --- | --- | --- | --- |
| WD1 | (994, 396) | (864, 312) | −130, −84 |
| AP1 | (40, 581) | (4, 497) | −36, −84 |
| AT1 | (908, 428) | (778, 344) | −130, −84 |
| IP1 | (18, 515) | (4, 431) | −14, −84 |
| ID1 | (808, 448) | (678, 364) | −130, −84 |

Minimize collapses the card to **139×32** and leaves a single **Show videos** button. Teacher and self tiles unmount while it is collapsed. During share the same drag worked again; on the phones the card was already against x = 4, so the second drag moved it upward only.

Shots: `shots/09-float-before/`. The expanded card sitting on the share is in `shots/11-coverage/` and on `shots/13-annotate/WD1.png` (tiles labeled **Jitendra Phand** and **WD1 Rev**, with **Minimize**, **Min**, **Hide**).

### 8. What students see, and how much chrome covers it — pass

With chat closed, every family showed the shared frame (largest decoded video, green test pattern, `blackPct` 0), the **Teacher screen** badge, the video float, and either a bottom control bar or a landscape rail. `greenPct` stays low (3.8–13.7) because the fake frame is an animated pattern, not a solid green field. Coverage that matters is `overlayPct`: the union of the video float, stage chrome, fullscreen badge, control bar or rail, and (when open) the chat panel.

Chat closed, then chat open:

| Device | Mode | Frame | Closed overlay | Open overlay | Chat cover |
| --- | --- | --- | --- | --- | --- |
| WD1 | primary 1366×768 | 1280×720, green 9.1% | 23.7% | 35.4% | 12.8% |
| AP1 | portrait 412×915 | 1920×1080, green 13.7% | 22.4% | 59.4% | 48.1% |
| AP1 | landscape 915×412 | 1920×1080, green 12.6% | 15.9% | 41.5% | 37.8% |
| AT1 | portrait 800×1280 | 1280×720, green 4.3% | 15.2% | 28.4% | 13.1% |
| AT1 | landscape 1280×800 | 1920×1080, green 5.0% | 21.4% | 34.3% | 13.1% |
| IP1 | portrait 390×844 | 1920×1080, green 3.8% | 24.6% | 61.5% | 47.9% |
| IP1 | landscape 844×390 | 1920×1080, green 3.9% | 18.1% | 45.7% | 40.9% |
| ID1 | portrait 820×1180 | 1920×1080, green 9.5% | 17.3% | 31.3% | 13.9% |
| ID1 | landscape 1180×820 | 1920×1080, green 8.8% | 21.1% | 34.6% | 13.9% |

Three `<video>` elements were in the DOM (share, teacher camera, self). Portrait phones are the outlier: opening chat takes the overlay from about a quarter of the screen to about **60%**. The control bar alone is a full-width strip (AP1 closed: chrome from y 817, height 98, on a 915-tall viewport).

Shots: `shots/11-coverage/{id}-{mode}.png`, `shots/11-share-stage/`.

Under the student control bar, after Mute all, the caption reads **Muted by teacher — wait to be unmuted**.

### 9. Annotate — pass

The Annotate control was **enabled**. Its title, quoted from the live button:

> Freeze the screen and draw on it in the classroom tab (students see the still picture with your drawing)

Visible label: **Annotate**. The share card still says “Share a window or a tab instead to see a live preview and draw on it.” Both strings were on screen together. Drawing did work on this entire-screen share.

The teacher drew two diagonals and a loop: (15,15)→(85,85), (85,15)→(15,85), and a polyline around the centre of the 0–100 viewBox. Teacher SVG path count **3**. Each of WD1, AP1, AT1, IP1, and ID1 already had the same three `d` attributes on the first poll. Poll overhead was 3–4 ms. The poll started 3573–3586 ms after the pen went down; that interval is the three gestures being drawn, then five students checked one after another. Per-stroke network time was not separated from the gesture, and it was already done before the first look.

`shots/13-annotate/teacher.png` and `shots/13-annotate/WD1.png` show the same red X over the green frame, with the same burned-in frame text **00:35:150 703**. That text is still **00:35:150 703** on `shots/14-hand-share/teacher.png`, taken after the annotate shot. That matches the button’s freeze claim. Phone annotate shots were taken with the chat sheet open, so the middle of the X sits under the sheet; the path data on those pages is the same `d`.

Share-controls tools visible once the strip is expanded: **Annotate**, **Pen**, **Marker**, **Erase**, colour dots, **Undo**, **Clear**, **Stop**, and the hand list.

### 10. Students cannot annotate — pass, teacher-only

On WD1, AP1, AT1, IP1, and ID1, no button label matched annotate, draw, pen, or eraser. The student page shows the strokes and has no drawing tool. This was checked twice, during share and after the teacher drew.

## C. Teacher video panel

### 11. Show 2 / 4 / 6 — pass, and the numbers disagree with each other

The control sits on the teacher video stack, next to the word **Float**. The live text is the digits **2**, **4**, **6**. The accessible names the session clicked are **Show 2 videos**, **Show 4 videos**, **Show 6 videos**.

The class started from the dashboard field **Max visible student videos** (value 6). The dashboard hint on screen:

> Only this many student camera streams reach you. Others stay local-only on their devices.

Before anyone pressed those digits, with 9 students in the room, the header read **6/6 videos shown · 9 students**.

Pressing the digits then did this (10 students in the room, teacher camera on, roster open). API `maxVisibleVideos` is the student-slot count. The visible-name list includes the teacher.

| Pressed | Student slots | Header | Tiles in the API visible list |
| --- | --- | --- | --- |
| Show 2 videos | 1 | **1/1 videos shown · 10 students** | teacher, AP1 Rev |
| Show 4 videos | 3 | **3/3 videos shown · 10 students** | teacher, AP2 Rev, AT1 Rev, ID2 Rev |
| Show 6 videos | 5 | **5/5 videos shown · 10 students** | teacher, WD1 Rev, AP2 Rev, AT1 Rev, ID1 Rev, IP1 Rev |

So the digit on the button is one higher than the header it produces, and the header counts student slots while the tile stack also shows the teacher. Show 2 puts two faces on screen and the header says 1/1. Show 6 moves a room that was reading 6/6 down to 5/5.

Shots: `shots/07-layout/show-2.png`, `show-4.png`, `show-6.png`, `shots/07-video/`.

### 12. Rotation — pass; speaker hold was not what the 40 seconds showed

After Show 6, `maxVisibleVideos` stayed 5. Samples every ~4 s for 40 s. The set of five students changed about every 8–9 s and then held for the next sample:

| Elapsed | Student tiles (teacher always included) |
| --- | --- |
| 0.5 s and 4.8 s | AP2, AT2, ID1, IP2, ID2 |
| 9.1 s and 13.4 s | WD2, AP2, AT2, IP2, ID2 |
| 17.7 s and 22.3 s | AP1, WD2, AT1, ID1, ID2 |
| 26.6 s and 30.9 s | AP1, AP2, AT1, ID1, IP2 |
| 35.2 s and 39.5 s | AP1, WD2, AT1, AT2, ID2 |

Distinct faces in that window: the teacher, AP2, AT2, ID1, IP2, ID2, WD2, AP1, AT1. WD1 and IP1 published (both were in the Show 6 snapshot immediately before the timer) and simply did not fall in these ten samples.

WD1’s microphone was locally open for this window (the button read **Mute microphone**) and the teacher mic had been muted. WD1 was not held in the five slots. A later frame, `shots/08-pin-fail/teacher.png`, does show WD1 in the stack with the label **Speaking**. The Speaking label is real. These 40 seconds do not show that label pulling WD1 into the rotation.

### 13. Pin — incomplete

The tile control is deployed. The click that failed resolved to a real button:

- class `peer-pin-btn`
- `aria-pressed="false"`
- title **Pin: keep this student in the panel**
- accessible name **Pin ID2 Rev (keep in the panel)**

The click waited 8 seconds and never completed (15:45:16Z). The script had already switched to Show 4 and had already issued the roster click **Pin WD1 Rev's video**. It threw before it could save whether that roster click stuck, whether the pin survived an 8-second rotation, whether unpin worked, or what a second pin returned when the slot count was full. Those four results are absent from `results.json`. They were not re-measured, because the Physics period was still open.

`shots/08-pin-fail/teacher.png` is the frame at the timeout. Header **3/3 videos shown · 10 students** (consistent with Show 4). Visible stack: **Jitendra Phand (you)**, **WD1 Rev** with **Speaking**, **AT1 Rev**, and a black tile **Connecting…**. ID2 Rev is in the roster, not in that stack, which is why a pin button for ID2 was in the DOM and not actionable. The roster lists raised hands first (AP1, AT1, IP1, ID1). Treat this shot as layout context, not as a proven pin.

## D. Hand raise

### 14. Several hands, staggered — pass

Raises from WD1 (Windows), AP1 (Android phone), AT1 (Android tablet), IP1 (iPhone), ID1 (iPad). The student button toggled between **Raise hand** and **Lower hand**. Server flag latency: WD1 398 ms, AP1 367 ms, AT1 380 ms, IP1 388 ms, ID1 395 ms.

The roster row’s text is the initials, the display name, and **9-ALPHA**. The hand is an icon, accessible name **Hand raised**, not a ✋ character in the row text. Rows that had already painted sorted to the top, earliest first:

- After AP1’s server raise, the DOM showed only WD1 at the top with the hand flag.
- After AT1: WD1, then AP1.
- After IP1: WD1, AP1, AT1.
- After ID1: WD1, AP1, AT1, IP1. ID1’s own row had not painted the icon in that same snapshot.

The newest hand lagged the server flag by about one sample. The order among painted hands was earliest first.

The teacher lowered WD1 with **Lower WD1 Rev's hand**. Server flag cleared in **659 ms**. The page text captured in that same moment still listed WD1 first, then AP1, AT1, IP1, ID1. The sort caught up later: the pin-timeout roster and the share HUD both show WD1 no longer among the raised hands.

No separate toast sentence was in the page text. The indicator is the roster icon and, while sharing, the HUD. With teacher chat open: roster closed, zero hand labels in the chat text, roster badge empty. Hands are not visible while the teacher is composing.

While sharing, AP2 raised a hand. The teacher opened **Raised hands** in the share controls. `shots/14-hand-share/teacher.png` lists, each with a **Lower** button:

> AP1 Rev, AT1 Rev, IP1 Rev, ID1 Rev, AP2 Rev

The frozen screen and the X stayed visible behind that panel. The footer chat/roster toggles are not the way in during a share; the hands live on **Share controls**, which itself only appears in this tab because the on-screen float could not be tracked.

Shots: `shots/04-hands/`, `shots/14-hand-share/teacher.png`.

## E. Cross-cutting

### 15. Waiting room, admit, direct entry — pass

Waiting room started on. Nine students (everyone except ID2) hit the lobby in 4107–4774 ms, all at `/join/S3TDTK?waiting=1&as=student`. Lobby copy, same shape for each:

> Waiting room Hi, WD1 Rev — you're in the lobby for REV ux · 9 (all divisions). Your teacher will admit you shortly. Keep this tab open. Leave

Join times: WD1 4774, WD2 4574, AP1 4574, AP2 4107, AT1 4244, AT2 4573, IP1 4423, IP2 4369, ID1 4493 ms. Waiting list was exactly those nine. No one else.

**Admit one.** Header button text **Admit WD1 R.** (first token, last initial, period). WD1 was in the classroom 3231 ms later.

**Admit all.** Remaining waiting names before the click: AP1 Rev, WD2 Rev, AP2 Rev, AT1 Rev, AT2 Rev, ID1 Rev, IP2 Rev, IP1 Rev. All nine first-wave students were then admitted, every one `mutedByTeacher: true`. Time from the click until the client was in the room: WD2 2426 ms, ID1 362, IP1 348, IP2 346, AT2 333, and the others under 30 ms (WD1 was already in). Header reached **10 students** once ID2 arrived. Admit all was safe: the waiting list was only TEST-REV.

**Direct entry.** Roster switch accessible name before the click: **Waiting room on. Turn off to let students in directly.** Visible text **Waiting room**. After the click, `waitingRoomOn` was false. ID2’s join returned in 4916 ms already at `/classroom/S3TDTK` with **Connecting to classroom…**, admitted, `mutedByTeacher` true, no lobby sentence in the captured text. The teacher side saw ID2 in class within 25 ms of the state check.

The waiting room was turned back on as soon as ID2 was in, so a real student with the school page open would not walk in. That restoration is recorded on purpose. `waitingRoomRestored: true`.

Shots: `shots/02-waiting/`, `shots/02-admitted/`, `shots/05-direct/`.

### 16. Mute — pass

On entry, every measured family: mic button **Muted by teacher**, disabled, 44×44. The bar caption seen later on the student shots is **Muted by teacher — wait to be unmuted**.

Roster **Unmute WD1 Rev**: server `mutedByTeacher` cleared in **1020 ms**, and WD1’s button was already **Unmute microphone**, enabled, at that check.

**Unmute all** (allowed: zero non-REV students admitted) moved WD1, AP1, AT1, IP1, and ID1 to **Unmute microphone**, enabled. It does not open the mic by itself. WD1 then pressed **Unmute microphone** and the button became **Mute microphone**.

**Mute all** took 1484 ms and returned all five buttons to **Muted by teacher**, disabled. Afterwards every TEST-REV student, including ID2, had `mutedByTeacher: true`. The teacher’s own mute flag stayed false.

Shots: `shots/06-mute/`.

### 17. Students do not receive each other’s video — pass

Before share, with the teacher camera on, each of WD1, AP1, AT1, IP1, and ID1 had exactly one inbound video: **320×180**, 15 fps, about 4–5 kbps (34–36 KB received). Video accessible names on the page: **Teacher camera** and **Your camera**. No classmate camera. During share the second inbound video is the teacher’s screen (question 6), still not another student.

This sample does not separately prove who can hear whose microphone. The one inbound audio stream measured during share is the teacher side (question 6).

Shots: `shots/07-video/`.

### 18. End class — pass

Confirm accepted by the session was **End class for everyone?** Any other dialog would have been dismissed, and the room would not have ended. Room status **ENDED**. Teacher landed on `https://13-201-89-150.sslip.io/teacher/dashboard`.

Every student, still on `/classroom/S3TDTK`, showed:

> Class ended Your teacher has ended this class. You can leave this page. Home

Home, for all ten, went to `https://13-201-89-150.sslip.io/student`. WD1’s page (`shots/15-ended/WD1-home.png`):

> Hi, WD1 Rev 9-Alpha You're checked in Physics 9 (all divisions) · 03:40 PM–04:20 PM Waiting for Jitendra Phand to open the class. You'll go in automatically — keep this page open.

The same sentence, with that student’s name, was on WD2, AP1, AP2, AT1, AT2, IP1, IP2, ID1, and ID2. School-app Home resolved to `/student`.

Shots: `shots/15-ended/`.

## Severity

1. **Medium — the header and the 2 / 4 / 6 digits count different things.** Show 2 leaves two faces up and prints **1/1 videos shown**. Show 6 takes a room that was reading **6/6** and prints **5/5**. The dashboard field is “max visible student videos”; the stage digits behave as “including you”; the header counts student slots. A teacher cannot trust the number in the header to match the control they just pressed. `shots/07-layout/show-2.png`, `show-6.png`.

2. **Medium — entire-screen share tells the teacher they cannot draw, and then lets them draw.** The card says “Share a window or a tab instead to see a live preview and draw on it.” The enabled Annotate button says it will freeze the screen and draw in this tab, and that is what happened. The on-screen float is also removed: “The floating controls were closed because their position on the shared screen could not be tracked.” Hands, pen, and chat during a full-screen share exist only in this tab, which is the tab the teacher was told to minimise. `shots/10-share/teacher.png`, `shots/13-annotate/teacher.png`.

3. **Awkward, not broken — private reply does not stick, and hands hide while chat is open.** To resets to Everyone after a DM. There is no Reply on a message. Opening chat closes the roster, and the composer has no hand line. The share HUD is the one place the hand list and the composer sit in the same surface (`shots/14-hand-share/teacher.png` vs the pre-share chat panel).

4. **Awkward — phone chat covers the work.** Portrait chat-open overlay is **59.4%** (Android) and **61.5%** (iPhone). Landscape chat still covers **37.8%** and **40.9%**. The drawing under that sheet is not readable. Tablets and iPads stay near **13%** because they are given the 320×420 desktop panel. `shots/11-coverage/AP1-portrait.png`, `IP1-portrait.png`, `AP1-landscape.png`.

5. **Not scored — pin hold, unpin, and the full-slot response were not measured.** The tile button exists with the copy above. The automated click targeted ID2, who was not a visible tile, and the rest of the pin script did not run. Do not treat `shots/08-pin-fail/` as a failed pin in the product.

6. **Low — teardown noise.** Teacher console: one HTTP 400 (the failed first login), one HTTP 410, one HTTP 401 (the admin student list after the class ended). AP2, AT1, and ID2 each logged six LiveKit data-channel “User-Initiated Abort” lines for their own participant as the room closed. Those three students still had the annotation paths and still reached **Class ended**. No other context logged a console error.

Share resolution was uneven (two students at 1280×720 and ~10–11 fps, three at 1920×1080 and 15 fps) on one fake monitor track. Recorded as a measurement, not filed as a defect: the receivers were eleven contexts in one Chrome.

## Cleanup

Class ended. Browsers closed. No Chrome process was still using `ux-review/media/green.y4m`.

TEST-REV rows were **not** deleted. `GET /api/admin/students` from this teacher session returned HTTP 401, and that route has no delete. They are left for manual cleanup:

| SID | Name | Grade | Division | Room | Subject |
| --- | --- | --- | --- | --- | --- |
| TEST-REV-WD1 | WD1 Rev | 9 | Alpha (9-ALPHA) | S3TDTK | REV ux |
| TEST-REV-WD2 | WD2 Rev | 9 | Alpha | S3TDTK | REV ux |
| TEST-REV-AP1 | AP1 Rev | 9 | Alpha | S3TDTK | REV ux |
| TEST-REV-AP2 | AP2 Rev | 9 | Alpha | S3TDTK | REV ux |
| TEST-REV-AT1 | AT1 Rev | 9 | Alpha | S3TDTK | REV ux |
| TEST-REV-AT2 | AT2 Rev | 9 | Alpha | S3TDTK | REV ux |
| TEST-REV-IP1 | IP1 Rev | 9 | Alpha | S3TDTK | REV ux |
| TEST-REV-IP2 | IP2 Rev | 9 | Alpha | S3TDTK | REV ux |
| TEST-REV-ID1 | ID1 Rev | 9 | Alpha | S3TDTK | REV ux |
| TEST-REV-ID2 | ID2 Rev | 9 | Alpha | S3TDTK | REV ux |

From the earlier simulation the same morning, these rows are also still present and were not touched: TEST-SIM-W1, TEST-SIM-W2, TEST-SIM-I1, TEST-SIM-I2, TEST-SIM-A1, TEST-SIM-A2 (last name Sim).

## Screenshot index

| Step | Path |
| --- | --- |
| Login, start | `shots/01-login/teacher.png`, `shots/01-start/teacher.png` |
| Lobby, admitted | `shots/02-waiting/`, `shots/02-admitted/` |
| Chat empty, chat thread | `shots/03-chat-empty/`, `shots/03-chat/` |
| Hands | `shots/04-hands/` |
| Direct entry | `shots/05-direct/` |
| Mute | `shots/06-mute/` |
| Show 2 / 4 / 6, student video | `shots/07-layout/show-2.png`, `show-4.png`, `show-6.png`, `shots/07-video/` |
| Pin timeout | `shots/08-pin-fail/` |
| Float before share | `shots/09-float-before/` |
| Share | `shots/10-share/` |
| Coverage, stage | `shots/11-coverage/`, `shots/11-share-stage/` |
| Chat during share | `shots/12-chat-during-share/` |
| Annotate (X and loop) | `shots/13-annotate/` |
| Hands during share | `shots/14-hand-share/teacher.png` |
| Ended, WD1 home | `shots/15-ended/`, `shots/15-ended/WD1-home.png` |

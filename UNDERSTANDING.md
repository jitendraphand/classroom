# How the web classroom works

This note is the contract the Windows teacher app follows. It was read from `/workspace/classroom` (Next.js 15, React 19, Prisma/Postgres, Redis, LiveKit). That tree was not modified. Students stay in Chrome or Edge. They do not install this app.

The live server is `https://13-201-89-150.sslip.io`. The permanent teacher class code used in earlier checks is `S3TDTK`. This document does not include passwords, session cookies, or LiveKit API secrets.

## Auth and the single session

Staff sessions are HS256 JWTs (`apps/web/src/lib/sessionTokens.ts`). Each role has its own cookie and its own `role` claim. A teacher token is only accepted as a teacher. Teacher sessions slide: 24 hours without use ends one (`TEACHER_SESSION_HOURS`), and `/api/auth/me` or `/api/auth/status` renews one that is over an hour old. The app calls `/api/auth/me` every 30 minutes and after the PC wakes, so a session stays alive while the app is open.

Over HTTPS the cookie name is `__Host-classroom_teacher` (Secure, Path=/, no Domain). On plain HTTP it is `classroom_teacher`. SameSite is Strict. The `__Host-` prefix matters on sslip.io, because a sibling host could otherwise plant a `Domain=sslip.io` cookie.

The token carries `sv` (session version) and `sid` (active session id). Login writes a new `activeSessionId` on the teacher row and puts that id in the token. A later login replaces it. The older device then gets `signed_in_elsewhere` and is signed out. Password change or reset bumps `sessionVersion` (`revoked`). Disable, sign-out, and a token minted before single sessions existed are `disabled`, `signed_out`, and `expired`. The Windows app shows the same sentences as `sessionClient.ts` and offers “Use this device instead”.

Logging this app in signs the teacher out of the web app, and the reverse. Native requests must not send `Origin` or `Sec-Fetch-Site`. The CSRF middleware (`lib/csrf.ts`) allows a write that has neither header, because those headers are how it recognises a browser. A body must be `application/json`. The Electron main process performs the fetches and stores the cookie in the app user-data `config.json`. The renderer never sees the cookie or the LiveKit token.

## Starting a class, the waiting room, admit

The teacher’s room is permanent. Starting a class opens a new session id, so the LiveKit room name changes and tokens from the previous class cannot join.

Waiting room defaults to on. Students who join while it is on sit in `WAITING` until the teacher admits them. Admit and Admit all move those rows to `ADMITTED`. Turning the waiting room off (`PATCH /api/rooms/:code/settings` with `waitingRoomOn: false`) admits everyone who is already waiting (`idsToAdmitOnToggle`). Turning it back on only affects later joins.

New students are created with `mutedByTeacher: true`. They cannot publish a microphone until the teacher clears that lock.

## Roster, mute, hands

Roster order (`sortRoster` in `lib/classSlots.ts`): students with a raised hand first, earliest `handRaisedAt` first (unknown times after known ones), then the teacher, then everyone else by display name.

Mute one and Mute all set `mutedByTeacher` and update the LiveKit grant so the student cannot publish a microphone. Unmute one and Unmute all only clear the lock. The student’s microphone stays off until they press “Unmute microphone” themselves. Mute all locks every admitted student again and clears sticky speaker pins.

Hand raises are listed earliest first in the roster and in the strip above the chat composer.

## Chat

Scopes stored on each message:

- `BROADCAST` — Everyone. Every admitted participant can read it.
- `DIRECT` — teacher to one student. Only that student and the teacher see it.
- `TEACHER` — student to the teacher. Other students do not see it.

The teacher posts with `{ text, to }` where `to` is `all` or a participant id. The server stores the row and pushes it on the LiveKit data topic `chat` to the identities allowed to read it. Clients still poll `GET /messages`. A student only receives broadcasts, their own notes to the teacher, and DMs addressed to them.

The recipient stays selected after a successful send. `resolveChatRecipient` keeps a student id only while that student is still admitted; otherwise the composer falls back to Everyone.

Reply (`replyTargetFor`):

- A `TEACHER`-scope message from someone else replies to the sender.
- A `DIRECT` message the teacher sent replies to its recipient.
- A `DIRECT` message from a student replies to that student.
- Broadcasts have no Reply target.

The raised-hands strip sits above the thread while composing, earliest first. Choosing a name sets To and focuses the input. The Windows copy of these two functions lives in `src/shared/chatReply.ts`. It is not imported from the classroom tree.

## Video panel: 2 / 4 / 6, rotation, speakers, pins

The 2, 4, and 6 buttons count tiles in the panel, including the teacher’s own tile. “6” is the teacher plus five student cameras. The server field `maxVisibleVideos` is the student cap, always `slots - 1` (`studentCapForSlots`). The header “X/Y videos shown” uses the same unit, so Y is 2, 4, or 6.

Who may publish a camera (`allocateSample`):

1. Students the teacher pinned, oldest pin first.
2. Unmuted speakers, sticky until they are muted.
3. Everyone else, rotated.

Pins count toward the cap and never exceed it. The client mosaic rotates about every 8 seconds among students who are not pinned and not sticky speakers. Students never subscribe to classmate cameras. They receive the teacher’s camera, screen, and screen audio, plus classmate microphones.

Pinning is `POST /api/rooms/:code/pin-student`. When the pinned count is already the student cap, the server returns HTTP 409 with `{ reason: 'pins_full', max }`. The message is “All N video slots are pinned. Unpin a student or show more videos first.” A pin is stored on the participant for this session, so it survives a teacher reconnect. It only keeps that student’s camera flowing to the teacher.

## Screen share, share audio, freeze-and-draw

The web app calls `getDisplayMedia` with:

- video ideal 1920×1080, frame rate ideal and max 15
- `systemAudio: 'include'`, `selfBrowserSurface: 'exclude'`, `monitorTypeSurfaces: 'include'`
- audio constraints with echo cancellation, noise suppression, and auto gain off

The video is published as `Track.Source.ScreenShare` at up to 1.5 Mbps and 15 fps. A 720p simulcast layer is added only when the shorter side is at least 720 × 1.25. Screen audio is a separate `Track.Source.ScreenShareAudio` track, music preset, DTX and RED off. If audio fails, the video share continues.

The Windows app does not publish a Chromium desktop video track. That path is DXGI Desktop Duplication, which paints a content-protected window black. Screen video is captured by the native helper with Windows.Graphics.Capture of the whole monitor (`CreateForMonitor`, `Direct3D11CaptureFramePool`, `Direct3D11CaptureFrame`, `GraphicsCaptureSession`). Choosing a window still captures the monitor that contains it. The pool is sized to the published frame, at most 1920×1080, so the scale happens on the GPU. A texture that comes back a different size is scaled with the D3D11 video processor, or on the CPU if that processor cannot be created. One staging read turns the BGRA texture into tightly packed RGBA. The publisher feeds that buffer to a `VideoFrame` when `MediaStreamTrackGenerator` is available, and to a canvas otherwise. Electron cannot take a raw `ID3D11Texture2D` into the WebRTC encoder, so that readback is the handoff between the helper process and Chromium. System audio, when the teacher ticks the box, still comes from a user-gesture `getDisplayMedia` call. Every video track on that stream is stopped. Only the audio is published, with the same screen-audio preset as the website. The checkbox says the extra video is discarded.

Teacher annotation on the website (freeze-and-draw, the `annotate` topic, `GET /annotate`) was removed; students draw instead (next section).

The Windows app does not freeze the WGC canvas. When a share starts it opens a transparent, frameless, always-on-top overlay over the shared monitor. That window is not content-protected. Every opaque classroom window calls `setContentProtection(true)` inside the Electron process: the control panel, the main window, roster, messages, devices, videos, and any other opaque popup. `isContentProtected()` is the check. The transparent region picker is left unprotected, because excluding a layered window composites as a black rectangle, and it closes before the share starts. Capture starts only after a desktop composition, so the exclusion is already in the frame. A separate process does not call `SetWindowDisplayAffinity`.

Tools live on their own capture-excluded “Annotate tools” window. Shapes are vectors (`id`, `type`, `points`, `color`, `width`, `opacity`, `text`, `timestamp`) so undo, redo, and clear redraw the list. The laser fades and is not stored. With annotate off, the overlay sets `WS_EX_TRANSPARENT` and ignores mouse events, and it is not focusable, so the application underneath stays usable. Coordinates are 0–1 of the monitor’s physical pixels (`x / screenWidthPx`, `y / screenHeightPx`). A CSS pointer is converted with that monitor’s scale and its physical origin from `dipToScreenRect`. The DIP origin is not multiplied by the scale, so a 150% monitor beside a 100% monitor stays aligned at 100%, 125%, 150%, 175%, and 200%. The overlay is resized when that display’s resolution or DPI changes.

The website no longer has teacher annotation or the `annotate` data topic (it was replaced by student drawing). The Windows app neither publishes nor listens on `annotate`: the teacher's marks exist only on the captured overlay, so students see them once, in the video. The overlay is not content-protected. A class share does not burn those strokes into the RGBA frame: on a normal GPU desktop the overlay is already in the Windows.Graphics.Capture texture, and burning the same list drew each mark a second time. The capture-test path still burns, and still skips an empty list and does not rasterize text, because a Remote Desktop session without a GPU left the layered overlay out of the texture. The observer’s frame is the monitor underneath the classroom windows, plus the overlay’s strokes, once.

## Student drawing, Video mode, desktop ink

Students can ask to draw on the teacher's share (`drawLogic.ts`, data topic `draw`, `POST /api/rooms/:code/draw`). The teacher allows one student at a time for 3 minutes (`DRAW_ALLOW_MS`); Revoke and Clear drawing end it. Strokes are normalised 0–1 to the shared picture; the server relays them without a participant identity and keeps them for late joiners (`GET /draw`).

On a browser share the website draws those strokes as SVG over the video. On a Windows share the app draws them on its captured overlay, on the real desktop, so they are in the video; it starts the share with `POST /stage {mode:'screen', desktopInk:true}`, the server keeps `room:CODE:desktop-ink`, and the room state returns `desktopInk: true`. With that flag the website draws nothing for viewers and only the drawer's own strokes for 1.5 s after each point (`DESKTOP_INK_FADE_MS`, `desktopInkShown`), so the pen feels immediate and nothing is doubled. Stopping the share (`mode:'idle'`) or a new browser share clears the flag.

Video mode (website: the HUD's Video button; `videoQuality.ts` `shareProfile`): `contentHint 'motion'`, `maintain-framerate`, 30 fps. The Windows app applies the same profile to its single 720p layer and restarts the WGC helper at 30 fps; it also turns it on and off by itself from the WGC frame rate (`videoMode.ts`).

Polling: the Windows app uses the website's `pollPolicy.ts` (copied byte for byte) for the state, chat and waiting intervals, slower while the LiveKit push channel is live.

## Fullscreen alerts and End class

Students are asked to stay in fullscreen. Leaving fullscreen or switching away does not remove them. The teacher sees “Left fullscreen” or “Switched away”, and a count of students not in fullscreen. The student sees “Tap to return to fullscreen” and can still hear the class.

End class asks “End class for everyone?”. After the room is ended, a student in the class page sees “Class ended”, “Your teacher has ended this class. You can leave this page.”, and a Home button. The student home also badges “Class ended” for that subject.

## LiveKit tokens, rooms, tracks, topics

Room name: `classroom_<CODE>_<sessionId>` (`livekitRoomName`). The session id changes every time the class is opened again.

Tokens last 10 minutes (`LIVEKIT_TOKEN_TTL`). A connected participant is refreshed by LiveKit. A copied token does not stay useful for long.

Teacher grant: may publish camera, microphone, screen share, screen-share audio, and data. Student grant: camera only while that identity is in the visible sample; microphone only when `mutedByTeacher` is false and a teacher is connected; never screen share; never data. Chat and annotation data are sent by the server or the teacher. Hidden admin observers can subscribe and publish nothing. They are not in the roster.

Track settings the Windows publisher uses (lighter than `lib/videoQuality.ts`, so the host, the SFU, and student devices move less video):

- Teacher camera: 640×360, 15 fps, 300 kbps, one layer.
- Microphone: speech preset, DTX and RED on.
- Screen: one 1280×720 stream, 8 fps, 700 kbps. No second simulcast layer. Video mode: 30 fps, 1.5 Mbps.
- Screen audio: music preset, DTX and RED off.

The token response carries the server's `mediaProfile` (`MEDIA_PROFILE`). With `low` (a small server or a shared school uplink, where the SFU's egress is students × these bitrates) the app uses the web app's low caps: the camera is one 320×180 layer at 12 fps and 120 kbps, and Video mode is 15 fps at 800 kbps (also for the native sidecar). Slides already sit under the low cap.

Students hold no LiveKit data grant. Their strokes, whiteboard ops, hands and draw requests go through API routes, and the server relays them as server packets (no participant identity). The app accepts `draw` and `wb` packets from the server only.

Data topics:

- `chat` — a stored chat message, pushed to the allowed identities.
- `cls-state` (`STATE_TOPIC`) — a nudge to re-read room state (mute, sample, admit, stage, end). HTTP polls remain as a backup: teacher 5 s when the data channel is up, 2 s when it is not.
- `annotate` (`ANNOTATE_TOPIC`) — stroke begin, point, erase, undo, clear. Version 1. The sender identity is the LiveKit identity, not the self-declared `from` field.

The SFU, WebSocket signaling, and TURN/STUN are the existing LiveKit process. Configuration is described in the README under “Signaling server”. The Windows app does not run a second signaling server.

# Android teacher app: build plan (plan only, no build in this batch)

Date: 2026-10-16. Scope: bring the Android teacher app (`apps/android`, Kotlin,
LiveKit Android SDK 2.29, minSdk 26 / targetSdk 35) to parity with the web and
Windows teacher apps for **phone and tablet teachers**.

> Source note: the feature list "what works or not by Android version" that was
> sent earlier was **not found** in the repo, `docs/`, `/workspace`, git logs or
> the bot's mailbox. The matrix below is rebuilt from the code (`apps/android`),
> git history (commits 4655658, 53ac1ab, 1a56cf2, ea14e2a, 65e477f, 1bafa84) and
> the emulator runs in `/workspace/android-test` (API 29 phone, API 34 phone and
> tablet). Please replace it with the original list if you still have it.

## Minimum version
**Android 8.0 (API 26) minimum, recommended Android 10+** for teachers who share
their screen. `minSdk = 26` already.

## Feature matrix (current app → target)

| Feature | Android 8-9 (26-28) | Android 10-12 (29-32) | Android 13-14+ (33-35) | Phone | Tablet | Status |
|---|---|---|---|---|---|---|
| Sign in, single session, "signed in elsewhere" handoff | yes | yes | yes | yes | yes | done |
| Start timetabled / ad-hoc class, admit / admit all | yes | yes | yes | yes | yes | done |
| Waiting room on/off (remembered per teacher since 2026-10-16) | yes | yes | yes | yes | yes | toggle done; default follows the server |
| Teacher camera (720p simulcast, switch) + mic | yes | yes | yes | yes | yes | done; align with 360p + 180p layer (web) |
| Screen share (MediaProjection) | video only; FGS type not needed | yes; **app audio capture from 10** | yes; FGS `mediaProjection` type + notification permission (13), per-session consent (14) | yes | yes | done (masking overlay) |
| Share system audio | no (API 29+) | yes (AudioPlaybackCapture) | yes | | | missing |
| Floating toolbar over other apps | yes (overlay permission) | yes | yes | yes | yes | done |
| Student videos column (2/4/6), pins, rotation | yes | yes | yes | narrow on phones | yes | done; port run-4 sticky TTL |
| Chat, roster, hands, mute / unmute all | yes | yes | yes | yes | yes | done |
| Student drawing on share (allow / revoke / erase) | | | | | | **missing** |
| Whiteboard (new, vector over data channels) | yes (Canvas) | yes | yes; stylus/S Pen pressure | small | best | **missing** |
| Rejoin after network loss | yes | yes | yes | yes | yes | done (1a56cf2); add 30 s+ token refresh like web |
| Multi-server media URL | n/a | | | | | works (uses `url` from /token) |
| Hardware encoder | MediaCodec VP8/H.264; VP9 HW rare | VP8/H.264 HW common | VP9 HW on most | | | use H.264/VP8 HW for share |

## Phases

| Phase | Work | Effort | Exit test |
|---|---|---|---|
| 0. Baseline | Re-run emulator suite (API 26, 29, 34 phone + 34 tablet) against current server; fix API drift (whiteboard flag, waiting room default, media URL) | 2-3 days | login → class → share → students see it on all four |
| 1. Bandwidth parity | Teacher camera 360p + 180p layer, share VP8/H.264 simulcast with 720p ≤450 kbps low layer, dynacast/adaptiveStream, subscribe student cams only when visible | 3-4 days | per-student egress within docs/BANDWIDTH.md |
| 2. Student drawing | Draw requests in roster, allow/revoke/clear, render student strokes on the share overlay (`draw` topic, same server API as web) | 4-5 days | 3 students draw, teacher revokes one, strokes removed |
| 3. Whiteboard | Kotlin port of `lib/whiteboard/model` (ops, snapshot, chunking; JSON identical) + Canvas renderer; tools (pen, highlighter, erasers, shapes, text, pages, backgrounds, undo/redo, export PNG/PDF via `PdfDocument`); publish over LiveKit data (`wb` topic), answer `req` packets | 8-10 days | web/Windows students render identical pages; late joiner snapshot |
| 4. Share audio + polish | AudioPlaybackCapture (10+), tablet two-pane layout, stylus palm rejection, battery/thermal throttling of capture fps | 4-5 days | tablet class of 45 min without thermal stop |
| 5. Release | Signed release APK/AAB, Play internal track or direct APK, docs | 2 days | install on 3 real devices (Android 8, 11, 14) |

Total ≈ **5-6 weeks** for one Android developer (≈ 23-29 working days).

## Risks
- **MediaProjection rules change each release** (13: notification permission;
  14: consent per session, FGS type checks; 15: status-bar chip). Keep share
  start inside a foreground service started from user action; test on 34/35.
- **OEM background killers** (Xiaomi, Oppo, Vivo, Samsung) stop the FGS or the
  overlay; needs a battery-optimisation prompt and OEM notes.
- **Low-end phones (2-3 GB RAM, Android 8-9)**: camera + share + encoder at once
  overheats; fall back to share-only and 5 fps slides.
- **VP9 hardware encoders** are missing/buggy on many SoCs; use VP8/H.264 for
  the share on Android (web students decode both).
- **Whiteboard parity**: the Kotlin model must stay byte-compatible with
  `lib/whiteboard/model.ts`; add shared JSON fixtures to both test suites.
- **Phone screen size** limits teacher UI (video column + roster + toolbar);
  phones get a reduced toolbar, tablets the full one.
- **Play policy** for overlay + accessibility-like permissions may need a
  declaration; direct APK distribution avoids review delays.

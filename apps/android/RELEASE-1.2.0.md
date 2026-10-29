# Classroom Teacher 1.2.0 (Android)

Version 1.2.0-20261029, version code 280 (1.1.0 was 205). Built 2026-10-29 by CI from the `android`
branch (commit ba4c0f4): run https://github.com/jitendraphand/classroom/actions/runs/40840541473,
pre-release https://github.com/jitendraphand/classroom/releases/tag/android-1.2.0-20261029-r10.

Download: [Google Drive, 1.2.0 folder](https://drive.google.com/drive/folders/1jMSCm_FjJs2xVsq85CCFDU352dY0MTvv)

| File | Size | SHA-256 | Use |
| --- | --- | --- | --- |
| `classroom-teacher-debug.apk` | 63,080,222 bytes | `eb33e0009fc6522719d2ccc5e16386ac1f2f642b8c109c8f1f0781e691779d5c` | Testing. Installs anywhere (all ABIs, debug key); uninstall the old app first |
| `classroom-teacher-release.apk` | not built yet | | For teachers, once the release key is in CI (below) |

The release APK for teachers is the signed one: add the release key (the one that signed 1.1.0, certificate
SHA-256 `7cfe1e01…cad982`) as repository secrets (see `COMPATIBILITY.md`, "Building and releasing") and
run the workflow by hand (Actions → Android teacher app → Run workflow, branch `android`). The run then
publishes `classroom-teacher-release.apk` as a pre-release; its "Release certificate" step shows the key.
That APK installs over 1.1.0 and keeps the teacher signed in; put it in the Drive folder. About 25 MB
(ARM only), down from 61 MB for 1.1.0.

## What changed

Whiteboard (same board as the web and Windows apps)
- Same tools, icons and groups: pen pressure, select / move, shape snapping, laser, triangle, dots and
  graph backgrounds; strokes drawn as smooth curves, the board cached in layers, pinch zoom.

Screen share and audio
- Smoother screen share: the floating toolbar is hidden from the capture by Android itself
  (FLAG_SECURE), so frames go straight to the encoder; the app checks this on real frames and falls
  back to masking the toolbar on phones that ignore the flag.
- Voice focus on the teacher's microphone, after the phone's own echo and noise cancellation: sound
  quieter than the teacher's voice is turned down. On by default; long-press the mic button to switch.

Big classes
- Waiting list and student list show 150 rows at a time with "Show more"; search finds anyone.

Updates
- The home screen shows "version x.y.z is available" or, below the school's minimum, "update required"
  with the school's download link (server settings `ANDROID_APP_LATEST`, `ANDROID_APP_MINIMUM`,
  `ANDROID_APP_URL`).

Works with the current server (`main`)
- Ad-hoc classes start again: the app sends the campus the server now requires (1.1.0 got "Required").
  Teachers with more than one campus pick "Campus · Grade".
- Sessions are renewed every 30 minutes and when the app comes back (the server signs teachers out after
  24 h without use).
- Camera and screen share follow the server's `MEDIA_PROFILE`, with the web app's settings: camera 360p,
  15 fps, 300 kbps (was 720p, 24 fps, 1.2 Mbps); on `low`, camera 180p at 120 kbps and share 1 Mbps at 10 fps.
- Student ink and whiteboard edits are accepted only through the server's relay, as on the web.
- While the live connection is up the app checks the server every 60 s instead of every 5 s (changes
  are pushed).
- Crash reports stay under the server's 8 KB limit (larger ones were refused).

Chat
- Private questions and private replies are marked in the chat. "Reply privately" answers the student
  who asked.

Security
- Plain `http://` only for a server on the school network; anything on the internet needs `https://`.
- The saved session is encrypted with a key in the Android Keystore.

Smaller download
- Release APK: ARM only (all phones and tablets), unused code removed: 25 MB (61 MB before).

## How it was checked

- CI: unit tests (shared logic: chat lines, server address rules, media presets, ink and whiteboard trust,
  poll timing; the whiteboard model checked against the web app's, voice focus against the web
  worklet's constants, roster paging, the update notice), debug and release builds with R8.
- The APK: built from ba4c0f4 and carries the voice focus and share-mask processors and the update check.
- The requests the app makes, replayed against the current server: ad-hoc start with the campus (200;
  without it 400), the token's `mediaProfile`, a crash report over 8 KB (413).

Not checked: the app itself on a phone. This environment cannot run Android, and the release build's
code shrinking has not been run on a device. Before giving it to teachers, try it on one phone: sign in,
start an ad-hoc class, camera, screen share with student ink, whiteboard, private chat reply, leave and
rejoin. If the release build misbehaves where the debug build does not, the shrinker removed something
the app needs: report it, and use the debug build meanwhile.

# Classroom Teacher 1.2.0 (Android)

Version 1.2.0-20261028, version code 207 (1.1.0 was 205). Built 2026-10-28 by CI from the `android`
branch (commit bf43157): run https://github.com/jitendraphand/classroom/actions/runs/40706826010,
artifact `classroom-teacher-android` (download it from the run page while signed in to GitHub; kept until
2026-11-27).

Download: [Google Drive, 1.2.0 folder](https://drive.google.com/drive/folders/1jMSCm_FjJs2xVsq85CCFDU352dY0MTvv)

| File | Size | SHA-256 | Use |
| --- | --- | --- | --- |
| `app-debug.apk` | 63,011,181 bytes | `83d5c210ddf10df2884f7837af18fabcac71edb431977c9cc61b17420d017e13` | Testing. Installs anywhere (all ABIs, debug key); uninstall the old app first |
| `app-release-unsigned.apk` | 25,262,119 bytes | `4f5594408d8f2627923675c7710c2fa4a50c81290bfad47d8c94f2493844725a` | Not installable until signed |

The release APK for teachers is the signed one: add the release key (the one that signed 1.1.0, certificate
SHA-256 `7cfe1e01…cad982`) as repository secrets (see `COMPATIBILITY.md`, "Building and releasing") and
re-run the workflow (Actions → Android teacher app → Run workflow, branch `android`): the run then has
`app-release.apk`, and its "Release certificate" step shows the key. That APK installs over 1.1.0 and
keeps the teacher signed in; put it in the Drive folder. About 25 MB, down from
61 MB for 1.1.0.

## What changed

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
  poll timing), debug and release builds with R8.
- The requests the app makes, replayed against the current server: ad-hoc start with the campus (200;
  without it 400), the token's `mediaProfile`, a crash report over 8 KB (413).

Not checked: the app itself on a phone. This environment cannot run Android, and the release build's
code shrinking has not been run on a device. Before giving it to teachers, try it on one phone: sign in,
start an ad-hoc class, camera, screen share with student ink, whiteboard, private chat reply, leave and
rejoin. If the release build misbehaves where the debug build does not, the shrinker removed something
the app needs: report it, and use the debug build meanwhile.

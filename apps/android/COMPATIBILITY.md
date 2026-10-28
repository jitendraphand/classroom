# Android teacher app: supported versions and OS limits

Version 1.2.0 (release notes and download: `RELEASE-1.2.0.md`; all releases:
[Google Drive](https://drive.google.com/drive/folders/1ZdOjIaa3R44BRH-GjokVSoDL1cvygfgX)). Supported: Android 8.0 (API 26, minSdk) to Android 15 (API 35, targetSdk). Phones from 360dp wide,
large phones, tablets and foldables, portrait and landscape (window size classes: compact < 600dp,
medium < 840dp, expanded ≥ 840dp). Display cutouts are handled by insets; text uses sp, so system
font scaling applies.

| Feature | 8.0–9 (26–28) | 10–11 (29–30) | 12–13 (31–33) | 14–15 (34–35) |
|---|---|---|---|---|
| Class, chat, roster, camera, mic | yes | yes | yes | yes |
| Screen share (MediaProjection) | yes | yes | yes | yes, one consent per share session |
| Pause / resume share without a new prompt | yes | yes | yes | yes (projection + foreground service kept) |
| Floating bubble (overlay permission) | yes | yes | yes | yes |
| Student ink over the shared screen | yes | yes | yes, overlay at 80 % opacity* | same* |
| Cutout-aware ink overlay | no cutout API (API 26–27) | yes | yes | yes |
| Notification permission prompt | not needed | not needed | not needed | asked (API 33+) |
| Whiteboard host (local + server copy) | yes | yes | yes | yes |

\* Android 12+ blocks touches passing through non-trusted overlays with opacity above 0.8; the ink
overlay is touch-through, so it is drawn at 0.8 opacity. Students see the ink at full strength
because their copy fades only after it appears in the capture.

OS limits
- Android 14+: a MediaProjection token is single-use. Stopping the share (Stop, system "Stop sharing"
  chip, leaving) needs a new consent next time; pausing does not.
- The system can revoke projection at any time (status-bar chip, lock screen on some OEMs); the app
  then ends the share cleanly.
- Some OEM skins kill background foreground services aggressively; keep battery optimisation off for
  the app on such phones.
- Secure windows (banking apps, password fields) appear black in the capture.

## How this app fits with the server and the other apps

The repository has three branches that make one product:

| Branch | What it is | How it talks to the server |
|---|---|---|
| `main` | The only server: Next.js app + web UI for admins, teachers and students, plus LiveKit, Postgres, Redis, Caddy | — |
| `windows` | Electron teacher app (separate project) | HTTP API + LiveKit; 22 web logic modules are copied byte for byte and CI checks them against `main` |
| `android` | This app (`apps/android`). The branch also carries an old copy of `apps/web`: do not deploy the server from this branch | HTTP API + LiveKit; the web logic is ported to Kotlin by hand |

Deploy the server from `main` only. When `main` changes a contract below, this app must follow by hand
(there is no automatic drift check as on Windows), so check this list on every server change.

What the app relies on (server `main`, 2026-10-28 or later):
- Teacher session cookie `__Host-classroom_teacher` (https) or `classroom_teacher` (http on the school
  network), sent explicitly; no Origin header, which the server's CSRF rule allows for native apps.
  Sessions end after 24 h without use: the app calls `GET /api/auth/me` every 30 minutes and when it
  comes back to the foreground to renew it.
- `POST /api/teacher/sessions/start` with `kind: "adhoc"` needs `campus` (from `gradeChoices[].campus`
  in `/api/teacher/schedule`). Builds before 1.2.0 failed here with "Required".
- LiveKit room `classroom_<CODE>_<sessionId>`, identity `teacher_…`. Data topics: `cls-state` and `chat`
  (wake-ups), `draw` and `wb` (ink and whiteboard). Students have no data grant: their ink and board ops
  arrive only through the server relay (no sender identity, `by` = the student). The app ignores
  packets that claim to come straight from a student.
- `GET /api/rooms/<code>/token` returns `mediaProfile` (`standard` / `low`, the server's
  `MEDIA_PROFILE`); the app sizes its camera and screen share from it, as the web app does.
- Chat: `POST /api/rooms/<code>/messages` with `to: "all"` or a student's participant id (private
  reply). Messages with `scope` `TEACHER` (a student's private question) and `DIRECT` (your private
  reply) are marked as private in the chat log.
- `POST /api/client-error` accepts crash reports up to 8 KB; the app sends at most 7,500 characters.

## Network and data use

| | Standard | Server `MEDIA_PROFILE=low` |
|---|---|---|
| Teacher camera | 640×360, 15 fps, 300 kbps + 320×180 90 kbps layer | 320×180, 12 fps, 120 kbps |
| Screen share | 15 fps, 2 Mbps + 720p 1 Mbps layer | 10 fps, 1 Mbps + 720p 600 kbps layer |
| State poll | 60 s while LiveKit is connected (pushes wake it), 2 s without, 30 s in the background | same |

Before 1.2.0 the camera sent 720p at 24 fps / 1.2 Mbps and the poll ran every 5 s.

Server address: `https://` for any server on the internet. Plain `http://` is accepted only for an
address on the school network (10.x, 172.16–31.x, 192.168.x, 169.254.x, localhost, `*.local`, `*.lan`,
`*.home.arpa`, IPv6 ULA / link-local), because it sends the password and the session cookie
unencrypted. The session cookie is stored encrypted with a key in the Android Keystore.

## Building and releasing

CI (`.github/workflows/android-app.yml`) runs on every push to `android` that touches `apps/android`:
unit tests, then the debug and release APKs, uploaded as the run's `classroom-teacher-android` artifact
with their SHA-256 in the log.

- Debug APK: every ABI (works on emulators), not shrunk, signed with the runner's throwaway debug key.
  Installable, but each CI run has a different key, so installing a newer one means uninstalling first.
- Release APK: ARM only (`arm64-v8a`, `armeabi-v7a`; every Android phone and tablet a school would use),
  code shrunk with R8 (class names kept, so crash reports stay readable). About half the size of the
  debug APK.
- Release signing: every release must be signed with the same key, or teachers have to uninstall
  the app (losing its saved sign-in) before installing the update. Release 1.1.0-20261024 was signed
  with the existing release key, certificate SHA-256 `7cfe1e01…cad982`: keep using that key. Give it to
  CI as four repository secrets: `ANDROID_KEYSTORE_BASE64` (the keystore file, `base64 -w0 release.jks`),
  `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. The "Release certificate"
  step of the run prints the certificate digest; check it starts with `7cfe1e01`.
  Without the secrets the release APK is unsigned and cannot be installed.
  Only if that key is lost: make a new one with
  `keytool -genkeypair -v -keystore release.jks -keyalg RSA -keysize 4096 -validity 10000 -alias classroom`
  (teachers then uninstall once), and keep a copy somewhere safe.
  Locally: `CLASSROOM_SIGNING=/path/to/signing.properties ./gradlew assembleRelease`
  (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`).
- Pre-filled server address: repository variable (or environment variable) `CLASSROOM_DEFAULT_SERVER`,
  the same name the Windows build uses. Default: `https://13-201-89-150.sslip.io`.
- Version: `1.2.0-<build date>`, version code 100 + commit count (CI checks out the full history).

Google Play: Play requires a recent target API for new apps and updates (raised every August; API 36
for 2026). This app targets API 35, which is fine for direct installs (Drive, MDM) but not for a new
Play listing. Moving to API 36 needs AGP 8.9+ and a pass over the Android 16 changes (edge-to-edge can
no longer be turned off, predictive back, orientation and resize limits ignored on large screens).

# Classroom Teacher 1.2.0 (Windows)

Built 2026-10-29 from the `windows` branch (with classroom `main` at 5b2fe5e). Unsigned (no
code-signing certificate), like earlier builds.

Download: [Google Drive, 1.2.0 folder](https://drive.google.com/drive/folders/1zmeWA7jgFsCE1sedvVYih5oa1Mop8HF9). Point the school server's `WINDOWS_APP_URL`
at this folder and set `WINDOWS_APP_LATEST=1.2.0`, so 1.1.0 shows "update available".

| File | Size | SHA-256 |
| --- | --- | --- |
| `ClassroomTeacher-setup.exe` (installer) | 109,601,739 bytes | `0db3f93336232d47951ede1b46209726e0a795d91d0d2da5796efdeb78818e4e` |
| `ClassroomTeacher-portable.exe` | 109,392,671 bytes | `920fca598e424c9655af30d6d390ad8e21426d965d7d539d6bbaece313fc4911` |

Check a download in PowerShell: `Get-FileHash .\ClassroomTeacher-setup.exe -Algorithm SHA256`.

## What changed

Whiteboard (same board as the web and Android apps)
- Pen pressure, select / move / resize, duplicate, shape snapping (hold still at the end of a stroke),
  laser pointer, triangle, dots and graph backgrounds, new icons.
- Undo after a snapped shape takes back the shape first, then the original stroke.

Clear audio
- Noise removal on the microphone: Standard, Enhanced (RNNoise, default) or Strong (GTCRN), and voice
  focus, which turns down sound quieter than the teacher's own voice. Falls back to Windows' own
  processing if one cannot run. See `docs/AUDIO.md` in classroom `main`.
- The Devices panel (microphone, camera, noise removal, voice focus, what is running now) opens from
  **Devices** in the class toolbar and from the floating tools' Meeting group; before, nothing opened it.

Big classes
- Waiting list and student list show 150 rows at a time with "Show more"; raised hands stay on top and
  search finds anyone.

## How it was checked

- 179 unit tests, typecheck, web-sync check against classroom `main` 5b2fe5e (CI run 3 on `windows`).
- During development, in Electron 44 under xvfb over `app://` with the engine's CSP: Enhanced and
  Strong noise removal both run.
- The installer contents: version 1.2.0, the noise-removal worklets and models in
  `dist/renderer/audio`, en-US only, no source maps.

Not checked here (Windows only): screen capture through the helper and sidecar, hiding the app's
windows from the share, the annotation overlay, DPAPI storage, noise removal on a real Windows
microphone, the installer on a real PC. Run `TESTING.md` on a Windows 10 and a Windows 11 PC before
giving it to teachers.

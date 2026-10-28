# Classroom Teacher 1.1.0 (Windows)

Built 2026-10-28 from the `windows` branch. Unsigned (no code-signing certificate), like earlier builds.

Download: [Google Drive, 1.1.0 folder](https://drive.google.com/drive/folders/1ZswNbO4COxPLH1-fV9sr_awfyOyC5dIm). Point the school server's `WINDOWS_APP_URL` at this folder so the app's "update available" notice opens it.

| File | Size | SHA-256 |
| --- | --- | --- |
| `ClassroomTeacher-setup.exe` (installer) | 109,348,453 bytes | `7cf72780b476a3f24056c2f70be61cb0f49ef7d08fe06295182c48ef33be9ebb` |
| `ClassroomTeacher-portable.exe` | 109,139,387 bytes | `e7d3d88a52fa28bd544341245f2eae0696f29dfdb839a48126aafb0582a1ad8a` |

Check a download in PowerShell: `Get-FileHash .\ClassroomTeacher-setup.exe -Algorithm SHA256`.

## What changed

Security
- Electron 36.9.5 (out of support since October 2025) → 44.10.0; electron-builder 26. `npm audit`: 0 vulnerabilities.
- Windows can no longer navigate away from the app's own pages; pop-ups, permissions and every IPC handler are limited to `app://classroom`. Before, a page reached by a dropped link got the teacher API bridge.
- Changing the server address forgets the session cookie (it used to be sent to the new server). The cookie is stored encrypted with Windows DPAPI.

Works with the current server
- Sessions are renewed every 30 minutes and after the PC wakes (the server now ends teacher sessions after 24 h without use).
- Follows the server's `MEDIA_PROFILE=low`: Video mode 15 fps / 800 kbps, teacher camera 180p / 120 kbps (web app parity).
- Website modules re-synced; drawing and whiteboard packets are accepted from the server relay only (students have no data grant).

Teaching
- Shortcuts are Ctrl+Alt+Shift+M / V / S (the old Ctrl+Shift+V / S took paste-as-plain-text and Save as from other apps, and stopped the share). Untouched old shortcuts move to the new ones automatically.
- Toolbar buttons have words under them; Leave is neutral and set apart from End class.
- "Let speak" next to a raised hand (roster and chat) unmutes the student and lowers the hand.
- The finished screen shows the class time and attendance ("3 of 30 students attended (2 late) · 2 absent").
- Dashboard: the teacher's name right after sign-in, school-time 24-hour times, no Start button on past classes, plainer wording.
- "Update available / required" notice when the school server sets `WINDOWS_APP_LATEST` / `WINDOWS_APP_MINIMUM` / `WINDOWS_APP_URL` (server commit df5e46f or later).

## How it was checked

- 178 unit tests, typecheck, web-sync check against classroom `main`, sidecar logic tests.
- The app itself (Electron 44 on Linux) in a live class against the current server with three browser students: sign-in, dashboard, ad-hoc class, admit, "Ask to speak" → "Let speak", private chat, End class with the summary, the navigation block, the cookie reset on server change, the update notice.
- The installer contents: version 1.1.0, capture helper rebuilt with MinGW, `share-sidecar.exe` from the 2026-10-24 build (its Rust source has not changed since), en-US only, no source maps.

Not checked here (Windows only): screen capture through the helper and sidecar, hiding the app's windows from the share, annotation overlay, DPAPI storage, the installer on a real PC. Run `TESTING.md` on a Windows 10 and a Windows 11 PC before giving it to teachers.

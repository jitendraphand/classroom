# Windows Optimization Audit (teacher app, `windows` branch)

**Scope:** Electron teacher app "Classroom Teacher" 1.2.0. It has its own git history. Students do not use it.

## Architecture (verified)
| Part | Tech | Role |
|---|---|---|
| Main process | Electron 44.10.0, `src/main/main.ts` (2,710 lines) | Windows, tray, permission handler, capture supervisor |
| Renderer | React + `livekit-client` 2.22.3, `src/renderer/classSession.ts` (2,550 lines) | Class UI, camera and mic publish, tiles (`adaptiveStream: false`, `dynacast: true`) |
| `affinity-helper.exe` | C / Win32 (`native/affinity-helper.c`, 1,273 lines) | Windows.Graphics.Capture of a monitor or window → raw RGBA frames on stdout |
| `share-sidecar.exe` | Rust, livekit 0.9, wasapi | Reads the helper's frames, composites ink, converts to I420, publishes the share as participant `teacher_…__screen`, WASAPI loopback audio |
| Shared logic | `src/shared/web/*` byte-copied from `main` | Checked by `tests/webSync.test.ts` |
| Packaging | electron-builder NSIS + portable x64, English-only locales, max compression, no auto-update | `electron-builder.yml` |

Why the sidecar exists: the control panel is excluded from capture (`setContentProtection`), and DXGI duplication would paint it black. WGC in a separate process gives a clean capture.

## Security posture
contextIsolation, sandbox, nodeIntegration off, webSecurity on, navigation and window-open guards, permission handler. Good.

## Findings
| ID | Issue | Evidence | Fix |
|---|---|---|---|
| REL-02 | 5 shared modules drifted from `main` (audioPolicy, voiceProcessor, voiceSettings, classFinish, WhiteboardBoard) | Byte diff (measured) | Run `scripts/sync-web.mjs`; release 1.2.1 |
| PERF-04 | `disable-renderer-backgrounding`, `disable-background-timer-throttling`, `backgroundThrottling: false` apply globally and permanently | `main.ts:148-149, 754` | Turn throttling off only for the publisher window during a share |
| PERF-09 | A second WebRTC stack and participant during a share (Electron + Rust) | design | Measure: two peer connections plus a duplicated DTLS/SRTP stack (estimated tens of MB RAM). Acceptable if the capture-exclusion requirement stands |
| — | High-DPI capture at 1080p+, then I420 conversion in the sidecar (CPU) | `main.rs` | Use the hardware encoder (flag exists: `"encoder":"hardware"`); verify that the I420 conversion is SIMD |
| — | No auto-update | `publish: null` | Server advertises versions (`/api/desktop/windows`). Add an in-app "update available" banner with a checksum-verified download |
| CQ-02 | README claims TURN is bundled; the server template has it disabled | `README.md:~99` vs `infra/livekit.example.yaml` | Fix the doc or enable TURN (REL-01) |

## Low-end PC considerations (4 GB RAM, integrated GPU, HDD)
- Electron's base cost (main + GPU + renderer ≈ 150–250 MB, estimate) is significant on 4 GB. The UI-only locales and stripped maps help install size, not RAM.
- HDD start-up: asar with max compression trades CPU for I/O. Measure cold start on an HDD.
- HW encode switches (Media Foundation VP9/AV1/H.264) reduce CPU where available; the software fallback is costly at 1080p.

## Verification plan (not run: no Windows host)
1. Cold-start time to sign-in (HDD and SSD).
2. `Get-Process | ? {$_.Path -like '*Classroom*'} | Measure-Object WorkingSet64 -Sum` every 5 s: idle, in class, sharing.
3. Idle CPU over 5 min in the tray, before and after PERF-04.
4. Sharing CPU and GPU with HW versus SW encode (Task Manager GPU engine "Video Encode").

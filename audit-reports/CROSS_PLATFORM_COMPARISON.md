# Cross-Platform Comparison

Students use **web only**. Android and Windows are **teacher** apps. "—" = not applicable.

| Aspect | Web (all roles) | Android (teacher) | Windows (teacher) |
|---|---|---|---|
| Codebase | `main:apps/web` (Next.js/React) | `android:apps/android` (Kotlin, Views) | `windows` (Electron + React; C helper; Rust sidecar) |
| Shared logic strategy | Source of truth | **Hand port** of web logic to Kotlin; no drift check (REL-03) | **Byte copies** of 29 web modules plus a CI test; currently 5 drifted (REL-02) |
| Auth | Cookies (`__Host-`), CSRF Origin rules | Cookie sent explicitly (no Origin, which the CSRF rule allows for native apps); Keystore-encrypted storage; `/api/auth/me` every 30 min | Cookie in the Electron session |
| Roles | Student, teacher, admin, observer | Teacher | Teacher |
| Classroom functions | Full | Class, chat, roster, camera, mic, MediaProjection share, floating toolbar, whiteboard host, student ink overlay | Full teacher set incl. region/window share, annotation, notepad, share HUD |
| Media SDK | livekit-client 2.22 | livekit-android 2.29 | livekit-client 2.22.3 + livekit-rust 0.9 (share) |
| Dynacast | on | **off (default)** (PERF-03) | on |
| adaptiveStream | on (students: pixelDensity 1 on phones) | off (default) | off, by design (tiles enabled explicitly) |
| Background behaviour | Teacher: no disconnect on pagehide. Students: disconnect on page leave; video keeps flowing in hidden tabs (DATA-01) | Drops student camera subscriptions in `onStop`; foreground service for mic/camera | Never throttles, all windows (PERF-04) |
| Screen share | getDisplayMedia, VP9 SVC + VP8 backup | MediaProjection; 2 layers | WGC via helper → Rust sidecar (separate participant), HW encode flags |
| Media profile `low` | yes | yes | yes |
| Noise removal | RNNoise/Speex worklets (on demand) | VoiceFocus capture post-processor | Same worklets as web (copied; 2 drifted files) |
| Updates | Server deploy | Manual APK (Drive / GitHub pre-release); `/api/desktop/android` advertises versions | Manual installer; `/api/desktop/windows` advertises versions; no auto-update |
| Tests | 598 unit + 4 integration | 10 JVM unit test files | ~40 unit test files plus e2e-sim/ux-review scripts (not run here) |
| Startup / RAM / CPU / battery | See WEB_OPTIMIZATION_AUDIT (measured load) | Not measured | Not measured |
| Accessibility | aria-labels (194), roles (81), aria-live (8); dark-only theme | sp text, system font scaling (COMPATIBILITY.md) | Not reviewed in depth |
| Min platform | Modern evergreen browsers; Safari VP9 caveat (REL-04) | Android 8.0 (API 26) – 15 | Windows 10+ (WGC) x64 |

## Unnecessary differences / opportunities
1. **Android dynacast** should match web and Windows (PERF-03).
2. **Logic drift:** three implementations of teacher rules (roster sort, mic rules, whiteboard model). Windows' generated-copy approach works when it is run; extend the same discipline to Android through shared JSON contract fixtures.
3. **Audio processing** differs per platform (VoiceFocus vs RNNoise). That is acceptable, but document the expected loudness and echo behaviour and test each against the same recorded fixture (the repo has `docs/eval/deepfilternet_eval.py` that could serve this).
4. Native conventions are respected (Android floating bubble, Windows tray). No need to force identical UI.

# Android Optimization Audit (teacher app, `android` branch)

**Scope correction:** this is a **teacher** app (`com.classroom.teacher`). There is no Android student app; students on Android use the web app in a browser (see WEB_OPTIMIZATION_AUDIT.md).

## Facts (verified)
| Item | Value | Source |
|---|---|---|
| minSdk / targetSdk / compileSdk | 26 / 35 / 35 | `app/build.gradle.kts` |
| UI | Android Views + ViewBinding, Material 1.12 | — |
| Networking | OkHttp 4.12, coroutines | `Api.kt`, `Realtime.kt` |
| Media | livekit-android 2.29.0; VoiceFocus capture post-processor | `MainActivity.kt:716-724` |
| Release build | R8 minify + resource shrink; ARM ABIs only (halves APK size) | `build.gradle.kts` |
| Background | Foreground service `microphone|camera`; MediaProjection via the SDK service; overlay toolbar | `AndroidManifest.xml` |
| Lifecycle | `onStop` drops student camera subscriptions and flushes the whiteboard; `onDestroy` releases renderers and disconnects | `MainActivity.kt:363-410` |
| Polls | State 60 s while connected, 2 s without, 30 s in the background; session renew every 30 min | `COMPATIBILITY.md` |
| Rotation of visible tiles | 8 s loop, skipped while not visible | `MainActivity.kt:1520-1531` |
| Size | `MainActivity.kt` 2,453 lines; 10 JVM unit-test files | — |

## Findings
| ID | Issue | Impact | Fix |
|---|---|---|---|
| PERF-03 | No `RoomOptions`, so dynacast and adaptiveStream are off (SDK defaults) | Encodes every simulcast layer of camera and share continuously: CPU, battery, heat, uplink on the teacher's phone | `LiveKit.create(ctx, options = RoomOptions(dynacast = true, adaptiveStream = true), overrides = …)` |
| REL-03 | Hand-ported web logic, no drift check | Behaviour divergence (roster rules, mic rules) | JSON contract fixtures from `main` |
| SEC-06 | `cleartextTrafficPermitted="true"` base config | Defence in depth only | Keep the app check; document |
| CQ-01 | 2,453-line Activity | Hard to profile and test | Extract ClassSession / Share / Roster controllers |
| — | `onLowMemory() = Unit` (`MainActivity.kt:207`) | No reaction to memory pressure | On `onTrimMemory(RUNNING_LOW)`: drop student tile subscriptions, release the whiteboard bitmap cache |
| — | targetSdk 35 | Fine for sideload; Play needs 36 in 2026 (documented) | Plan the AGP 8.9 upgrade |
| — | Hard-coded default server `https://13-201-89-150.sslip.io` | Reveals infra; the wrong default for other schools | Require `CLASSROOM_DEFAULT_SERVER` in CI release builds |

## Low-end device considerations
- Views (not Compose) and a small dependency set are good for low-end phones.
- Camera capture: teacher 640×360 @ 15 fps (the web parity profile), cheap.
- Screen share: two layers (top + 720p) **without dynacast**, which is the main avoidable cost.

## Verification plan (not run: no device or emulator)
1. `adb shell am start -W com.classroom.teacher/.MainActivity` (cold start).
2. `adb shell dumpsys meminfo com.classroom.teacher` at sign-in / in class / sharing.
3. Android Studio CPU and Energy profiler over 10 minutes of sharing, before and after PERF-03.
4. `adb shell dumpsys batterystats --reset` → 30-min class → `dumpsys batterystats` per-UID.
5. Check SFU stats for the number of active layers published with 0 subscribers.

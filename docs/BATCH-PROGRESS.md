# Windows batch progress (on top of ffd8fae; web at 7eb5f5c)
Items: 1 sync+batch erase, 2 native sidecar publisher (Option A), 3 annotate toolbar, 4 hw encode, 5 helper priority, 6 pause hidden tiles, 7 low-power mode.
- [ ] 2: feasibility probe (system rust only, no rustup/cargo-xwin/clang)
- [x] 1: sync-web adds eraseBatch/deviceTakeover/classFinish/reconnectQuality; eraser uses createEraseBatcher (≤50 ids); takeover notice on teacher; shared/eraseQueue removed; 112 tests pass
- [x] 5: helper SetPriorityClass BELOW_NORMAL after 3 s static, NORMAL on first changed frame
- [x] 6: student tiles enabled only when panelShownNow() (floating window shown during share / main window not minimized)
- [x] 7: low-power (shared/lowPower.ts): toolbar "Eco" toggle, persisted; slides 5 fps, video 15 fps (helper fps + encoder cap), tiles 160x90 @7 fps
- [x] 4 (Electron path): HW_ENCODE_FEATURES appended to the single enable-features switch
- [x] 3: compact floating annotate toolbar (tools.tsx + shared/toolbarLayout.ts, horizontal/vertical dock via annotate-tools-orient IPC); tests/round5.test.ts
- [x] 2: native/share-sidecar (Rust, livekit 0.9.4, cargo-xwin → x86_64-pc-windows-msvc, ~31 MB). Runs the helper as child, composites ink, I420, publishes VP9 L1T3 (VP8 retry) as teacher_…__screen + WASAPI loopback audio. Main: pump wrap, 15 s publish wait → fallback to Electron path. Web: POST /api/rooms/[code]/screen-token (needed).
  Smoke (Wine + local livekit 1.13.9 + fake helper): connected, published VP9 + opus; Chrome subscriber decoded 640x360 VP9, 62 frames/8 s.
- [x] 4 (sidecar): VideoEncoderBackend::Hardware requested; livekit's Windows libwebrtc build has no HW encoders compiled → software libvpx fallback.
- [x] Build: setup 97,141,324 B / portable 96,934,526 B (bundle share-sidecar.exe). Web f7b9790 deployed (backup ~/classroom-backup-20261010-223308). Release windows-debug-20261010d published, asset sizes verified.

# Trial-2 fixes (2026-10-14, report /workspace/grok-review2/REPORT.md; web unchanged)
- [x] 1 Share dies silently: main fetches a fresh screen token (POST /api/rooms/<code>/screen-token, path from the class code sent with the sidecar request) before EVERY supervised sidecar restart (display change, no-frames, helper/sidecar exit); a restart only counts as recovered once the sidecar re-publishes (15 s); Video mode / share sound re-sent. Renderer: sidecar shares now stop on wgc-ended / supervisor `failed` (previously only shares with a wgcHandle did, so the UI kept Stop); "Share stopped — click to restart" button + notification + main window restored; leave-while-sharing → share resumes automatically after Rejoin (same class). Token TTL left at 10 m (server change not required: a token is only used at connect, and LiveKit refreshes live sessions).
- [x] 2 Annotate toolbar: panel measures its one-line content and main sizes the window to it, clamped to the current display's work area (DIP, any scaling); too tall → wraps into 2+ columns (horizontal → rows), panel reports leftover overflow for an extra line (max 3), then scrolls; drag end clamps fully on-screen; refit on display-metrics-changed.
- [x] 3 150 % scaling: helper matches the monitor by largest overlap when the rect misses by >8 px, DwmFlush bounded to 400 ms (an unbounded flush can keep the helper from ever reporting ready). If the helper fails at share start, main no longer retries the helper (another 8 s); the class window falls back to Chromium desktop capture (getUserMedia chromeMediaSource=desktop) and publishes from Electron, with a notice. Not verified on a real 150 % machine.
- [x] 4 Reply privately: local reply target wins immediately (no race), reply input focused after re-render, "Replying privately to <name>" line; send uses that target.
- [x] 5 Rotation tiles: only admitted students still in the LiveKit room (presentStudents).
- [x] 6 Student ink → overlay: path verified by reading (server data packet topic `draw`, participant undefined → classSession → student-ink IPC → overlay drawStudentInk → ink layer composited/sent to sidecar); extracted shared/studentInk.ts and covered bytes→strokes→canvas pixels in tests. No bug found. Gap noted: window shares map ink to the whole monitor.
- Tests: tests/round6.test.ts (13); full suite passes.

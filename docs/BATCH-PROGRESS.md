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

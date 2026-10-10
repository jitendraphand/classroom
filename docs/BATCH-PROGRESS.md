# Windows batch progress (on top of ffd8fae; web at 7eb5f5c)
Items: 1 sync+batch erase, 2 native sidecar publisher (Option A), 3 annotate toolbar, 4 hw encode, 5 helper priority, 6 pause hidden tiles, 7 low-power mode.
- [ ] 2: feasibility probe (system rust only, no rustup/cargo-xwin/clang)
- [x] 1: sync-web adds eraseBatch/deviceTakeover/classFinish/reconnectQuality; eraser uses createEraseBatcher (≤50 ids); takeover notice on teacher; shared/eraseQueue removed; 112 tests pass
- [x] 5: helper SetPriorityClass BELOW_NORMAL after 3 s static, NORMAL on first changed frame
- [x] 6: student tiles enabled only when panelShownNow() (floating window shown during share / main window not minimized)
- [x] 7: low-power (shared/lowPower.ts): toolbar "Eco" toggle, persisted; slides 5 fps, video 15 fps (helper fps + encoder cap), tiles 160x90 @7 fps
- [x] 4 (Electron path): HW_ENCODE_FEATURES appended to the single enable-features switch
- [x] 3: compact floating annotate toolbar (tools.tsx + shared/toolbarLayout.ts, horizontal/vertical dock via annotate-tools-orient IPC); tests/round5.test.ts

# Web Optimization Audit

## Measured (see PERFORMANCE_BENCHMARKS.md for method)
- Entry routes: 104–109 KiB gzip JS; first visit 221 KiB total (fonts 80 KiB); warm navigation 8 KiB.
- Classroom route: **1,294 KiB raw / 365 KiB gzip** JS (11 files); `/admin/live/[code]` 383 KiB gzip.
- FCP/LCP on an emulated low-end phone: 0.84–0.93 s on slow 4G; 2.37–2.45 s at 400 kbps / 400 ms RTT. CLS 0. DOM 40–55 nodes on entry pages. JS heap ~3 MB.
- Static assets immutable for 1 year; HTML `no-store`.

## Bundle
| Issue | Evidence | Fix | Expected |
|---|---|---|---|
| Teacher-only code in the student bundle | Static imports in `ClassroomRoom.tsx` (TeacherShareHud, TeacherPeersFloat, AnnotateTools, TeacherInk, whiteboard editor). Only `Chat` uses `next/dynamic` (`:76`) | `next/dynamic` gated on `isTeacher` | −15–30% route JS for students (estimate; verify with the bundle analyzer) |
| livekit-client is ~531 KiB raw | Chunk `144d3bae…` | Unavoidable; already shared and cached | — |
| Fonts 80 KiB | Inter + Outfit | System stack, or one subset | −30–80 KiB first visit |
| Noise-suppression WASM | Fetched on demand only (`voiceProcessor.ts:263-265`) | — | Already optimal |

## Runtime (code review; CPU/RAM not measured on devices)
| Area | Observation | Verdict |
|---|---|---|
| Re-rendering | `ClassroomRoom.tsx`: 37 `useState`, 44 `useEffect`, no `React.memo` in the shell | Risk of shell-wide re-renders on every state poll or nudge. Profile with React DevTools on a throttled CPU; memoise the heavy children (stage, roster) |
| Timers on the student page | StudentMediaPrivacy sync every 3 s; StudentViewStage check every 4 s; heartbeat 40 s; polls 60 s | Cheap individually; make the 3–4 s loops event-only, or skip them while hidden |
| Video while hidden | `pauseVideoInBackground: false` | DATA-01 |
| Camera preview when not published | Device open (`SelectivePublisher.tsx:52-58`) | PERF-05 |
| Wake lock | `useScreenWakeLock.ts` | Good: prevents sleep mid-class. Make sure it is released on end and on hidden (the browser does it automatically on hidden) |
| Leave on tab close | `disconnectOnPageLeave: !isTeacher` + `StudentLeaveOnPageHide` | Good |
| Event listeners | Hooks remove listeners in cleanups (sampled: StudentMediaPrivacy, SpotlightFloat, TeacherPeersFloat) | Good |
| WebSockets | One LiveKit signal WS; SSE only as a fallback | Good |

## Browser compatibility
- VP9 SVC publishing on Chromium only (`shareUsesVp9`); Safari and Firefox publish VP8 simulcast.
- Subscriber fallback for non-VP9 devices is unverified on LiveKit 1.13.9 (REL-04).
- Document PiP for the share HUD on Chromium 116+, with fallbacks.

## Resource cleanup checklist (from code)
| Event | Stops? |
|---|---|
| Tab hidden | Polls slow down ✓; **video keeps flowing ✗** (DATA-01) |
| Camera disabled | Track unpublished then stopped (`unpublishThenStop`) ✓ |
| Mic disabled / grant revoked | `ownMicCurrent` check republishes or stops ✓ |
| Tile invisible (teacher) | Unsubscribed ✓ |
| Participant leaves | Tracks unsubscribed by the SDK ✓ |
| Class ends | `room.disconnect()` on ENDED ✓ |
| Network lost | Resume / rejoin; no duplicate rooms (keyed remount) ✓ |

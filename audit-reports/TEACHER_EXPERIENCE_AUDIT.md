# Teacher Experience Audit

Platforms: web, Android app, Windows app. Source tracing only.

## Journey (web)
| Step | Implementation | Findings |
|---|---|---|
| Sign in | `/login`; forced first-time password change | One active session (other device signed out with a reason) |
| Dashboard | Today plus the next 6 days; **Start class** from 10 min before; ad-hoc classes for assigned grades | Clear; 30 s refresh poll |
| Start | Permanent room code; lands directly in class; fullscreen enforced on web (latest commit `d9aa9a0`) | — |
| Admit | "N waiting · Admit" / Admit all | — |
| Teach | Mic, camera (starts off), share (+ video mode), whiteboard, annotate, laser | Rich toolset |
| Manage | Roster (3-state mic, name-only, raised hands), mute all, per-student unmute allow (camera-gated), spotlight, rotate sample, draw permission | Many controls; grouped into the floating HUD while sharing |
| Chat | Broadcast / DM / reply | — |
| End | End class → attendance saved | Admin can also end |
| Attendance | `/teacher/attendance` | CSV export |

## Strengths
- **Teach-while-sharing HUD** with three hosting fallbacks (Document PiP → popup → in-page sheet), and the floating toolbar on Android.
- Server guarantees: students are muted when the teacher drops; a stale stage is cleared on reconnect.
- Native apps for teachers whose laptops struggle with browser sharing (Windows WGC + HW encode).

## Problems (teacher role)
| Problem | Finding | Fix |
|---|---|---|
| Windows app lacks the latest mic/echo fixes | REL-02 | Re-sync, 1.2.1 |
| Android phone encodes unused layers (battery/heat during a 1-h class) | PERF-03 | Dynacast |
| Windows app keeps every window un-throttled even when idle | PERF-04 | Scope to the share |
| Students who cannot connect appear as "absent/waiting" with no reason shown | REL-01 / UX-01 | TURN; show "media failed" in the roster |
| Hand-raise spam cannot be throttled | SEC-04 | Rate limit + "lower all hands" (verify it exists in the UI) |
| Self-service password reset missing | FEATURE §1 | Admin reset exists; acceptable |
| Cognitive load: many roster states (mic 3-state, hands, draw, spotlight, sample) | — | Keep the per-student menu progressive; first-time hints |

# Student Experience Audit

Platform: **web only** (phones, tablets, laptops). Source tracing only; screens were not rendered with live data (no database here).

## Journey
| Step | What happens (code) | Clicks | Findings |
|---|---|---|---|
| 1. Arrive | School-app link (auto sign-in) **or** home → "Join the class" → first and last name, grade, campus, foundation | 0 (link) / ~6 (form) | Form identity is name-based (UX-02, SEC-02) |
| 2. Route | `/student` routes to the class open now, a countdown, or "no class right now"; it auto-moves into the waiting room when the class opens | 0 | Good: no polling of a code by hand |
| 3. Wait | Waiting room; "Not you?" switch; permissions card | 0 | Waiting poll 3 s / 8 s hidden: fine |
| 4. Admitted | Fullscreen stage: teacher share, floating teacher camera, right-side control panel (mic, cam, chat, raise hand, draw request, quality, leave), class-info "i" | 0 | One layout on every device (consistent) |
| 5. Speak | Raise hand → teacher allows or unmutes; mic locked while the teacher is absent | 1–2 | Clear "Mic locked — teacher not in class" copy |
| 6. Chat | Drawer; messages go to the teacher only | 2 | Good: no classmate harassment channel |
| 7. Draw | Request to draw → teacher allows (3 min) | 1 | — |
| 8. Data | Quality button: Full → Low → Audio + share | 1–2 | No audio-only mode (DATA-02); no auto-suggest |
| 9. Network trouble | "Reconnecting to class…" pill | — | No quality indicator (UX-01); no TURN (REL-01) |
| 10. End | End screen, feedback form | 0–3 | — |

## Strengths
- Near-zero-click path from the school app.
- Students cannot be seen by classmates (privacy) and do not send video unless shown: a big battery and data win.
- Copy is plain and specific (camera and mic error messages in `SelectivePublisher.tsx:31-48`).

## Problems (student role)
| Problem | Finding | Fix |
|---|---|---|
| Background tab keeps downloading video | DATA-01 | Pause after 20 s hidden |
| Cannot drop the share on a weak or metered link | DATA-02 | Audio-only + slide snapshots |
| "Is it me or the class?" | UX-01 | Signal bars + suggestion |
| Typo in name = a new person | UX-02 | Roll number / PIN |
| School firewall blocks media | REL-01 | TURN/TLS 443 |
| Camera stays on for self-preview | PERF-05 | Auto-stop preview when not visible to anyone |
| First load ~365 KiB gzip JS for the class | PERF-01 | Split teacher code |
| Missing: homework files, recordings or notes for absentees, progress | FEATURE audit §3 | Product roadmap |

## Mobile experience
- Viewport handled with `h-dvh-safe`; phones get `pixelDensity: 1` (smaller share layer); a wake lock is used (`useScreenWakeLock.ts`).
- Touch: floating panels with clamping (`floatGeometry.ts`).
- Measured entry-page FCP on an emulated low-end phone: 0.84–0.93 s (4G profile), 2.4 s (400 kbps).

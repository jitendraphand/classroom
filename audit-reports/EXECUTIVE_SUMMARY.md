# Executive Summary

**Product:** Classroom, a live online teaching platform for one school group: Next.js web app, LiveKit SFU, Postgres, Redis; plus native **teacher** apps for Android and Windows.
**Audit scope:** `main` @ `d9aa9a0` (server + web), `android` @ `668ef56`, `windows` @ `5f707ea`. No production systems were accessed and no code was changed.

## Executive dashboard

| Metric | Count |
|---|---|
| **Total findings** | **33** |
| Critical | 1 |
| High | 6 |
| Medium | 14 |
| Low | 12 |
| Security vulnerabilities (SEC-*) | 9 (1 critical, 1 high, 3 medium, 4 low) |
| Performance problems (PERF-*) | 9 |
| UX issues (UX-*, plus DATA-02) | 3 |
| Server optimisation opportunities | 5 (PERF-06/07/08, SEC-04/05) |
| Student-device optimisation opportunities | 5 (DATA-01, DATA-02, PERF-01, PERF-02, PERF-05) |
| Bandwidth optimisation opportunities | 4 (DATA-01, DATA-02, PERF-02, PERF-03) |
| Scalability / reliability risks | 6 (REL-01..04, INF-01, INF-02) |

> **Update (same day):** 16 findings are fixed or partly fixed on `main`; see the *Fix status* table in FINDINGS_REGISTER.md. The dashboard below describes the code as audited.

## The verdict in one paragraph

This is an unusually well-engineered system for its resource goals. The biggest decisions are already right. It is an SFU (LiveKit) with **selective student publishing**, enforced in the server-side token grant: only a rotating sample of ≤6 student cameras ever reaches the SFU. Students never auto-subscribe, and publisher-side track permissions keep classmates' cameras private. Screen share uses VP9 SVC. Polling is push-driven (data-packet nudges with 60 s safety polls). Join waves are paced. Web workers are sized to the host. I would **not** recommend any architectural change. The serious problems are narrower: one **critical dependency vulnerability**, an **unauthenticated student identity model** that is on by default, **no TURN relay** for restricted networks, and a few student-side **data leaks**: video keeps flowing in background tabs, and there is no audio-only mode. The two native apps (both teacher-only) are drifting from `main`, and there is **no automated end-to-end or real-media testing**.

## Answers to the brief's 18 questions (short form)

1. **How it works:** see REPOSITORY_ARCHITECTURE.md. One VM, docker-compose with host networking: Next.js (Node cluster) ↔ Postgres/Redis; browsers ↔ LiveKit SFU over WebRTC; LiveKit → web app by webhook.
2. **Roles:** Student (web only), Teacher (web, Android, Windows), Admin (SYSTEM and SUB with privileges, plus a linked teacher-admin), hidden Admin observer. There is no parent role.
3. **Do features work?** 598/598 unit tests pass (measured). End-to-end flows could not be run here (see PERFORMANCE_BENCHMARKS.md). Out of scope by design: no recording, no assignments or assessments, no payments.
4. **UI/UX:** consistent and student-focused (one student layout everywhere). Gaps: no network indicator for students, and a name-based join form.
5. **Live tech (verified):** LiveKit server 1.13.9 SFU; livekit-client 2.22 (web, Windows renderer); livekit-android 2.29; livekit-rust 0.9 (Windows share sidecar). Opus+RED+DTX audio, VP8 cameras, VP9 L2T3_KEY share with VP8 backup. Chat and control go over HTTP and Redis plus server-originated LiveKit data packets, with SSE as fallback.
6. **Efficient?** Yes. Students receive at most teacher audio, a small teacher camera, the share, and classmates' microphones (which cost nothing while silent).
7. **Student data (estimates from encoder caps):** audio-only listening ≈ 15–30 MB/h; whiteboard lesson ≈ 45–70 MB/h; slides share on a phone ≈ 160–250 MB/h; on a laptop ≈ 270–400 MB/h; video mode ≈ 500–720 MB/h. App launch ≈ 221 KiB cold, 8 KiB warm (**measured**). Classroom JS ≈ 365 KiB gzip once per release (**measured**).
8. **Student CPU/RAM:** not measured (no device lab). Code-level risks: the 1.3 MB classroom bundle, background decoding (DATA-01), and the camera kept open for preview (PERF-05).
9. **Server per user:** repo load tests report LiveKit at ≈4.1 cores per ≈410 connections, and egress is the real limit (≈0.6 Mbps per student). I did not re-measure (blocked; see PERFORMANCE_BENCHMARKS.md).
10. **Native apps:** Windows is well hardened (sandbox, contextIsolation) but drifting (REL-02) and never throttles in the background (PERF-04). Android lacks dynacast (PERF-03).
11. **Mobile web:** first-visit FCP/LCP 0.84–0.93 s on an emulated slow-4G mid-tier phone and 2.4 s on a 400 kbps link (**measured**). CLS is 0.
12. **Secure?** Strong basics: CSRF origin checks, `__Host-` cookies, single active session, server-side media grants, signed webhooks, no raw SQL injection paths. It falls down on SEC-01 (patch Next.js now) and SEC-02 (unsigned identity).
13. **Scale?** 2,500 students on one large box is the stated target, with load-test history up to 1,500. Egress is the ceiling, and multi-media-node support exists.
14. **Unnecessary complexity:** three hand-maintained teacher clients (web, Electron, Kotlin) and god-files of 2,400–4,800 lines.
15. **Highest-benefit fixes:** see the Top 10 below.
16. **Cut operating cost:** egress dominates. DATA-01 and DATA-02 cut what the SFU sends to disengaged students and students on bad networks; MEDIA_PROFILE=low exists for small boxes.
17. **Weak networks:** enable TURN/TLS on 443 (REL-01), add audio-only and auto-downgrade (DATA-02), and add a student network indicator (UX-01).
18. **Prevent bloat:** LOW_RESOURCE_ENGINEERING_STANDARD.md defines bundle, egress and poll budgets with CI enforcement.

## Top 10 actions (impact ÷ effort)

| # | Action | Finding | Effort |
|---|---|---|---|
| 1 | Upgrade `next` to ≥15.5.29 and set `images.unoptimized: true` | SEC-01 | 1 h |
| 2 | Production default `SCHOOL_JOIN_MODE=signed`; put `/join-class` behind a flag; enable the per-IP join limit | SEC-02, SEC-03 | 0.5–1 day |
| 3 | Pause student video when the tab has been hidden for more than 20 s | DATA-01 | 0.5 day |
| 4 | Enable LiveKit TURN/TLS (443 or 5349) | REL-01 | 1 day plus DNS |
| 5 | Re-sync the Windows shared modules; release 1.2.1 | REL-02 | 0.5–1 day |
| 6 | `RoomOptions(dynacast = true, adaptiveStream = true)` on Android | PERF-03 | 1 h plus a device check |
| 7 | Nightly `pg_dump` off-box plus a restore drill | INF-01 | 0.5 day |
| 8 | Caddy `request_body max_size`, plus per-route rate limits for hand and draw | SEC-04, SEC-05 | 0.5 day |
| 9 | Audio-only mode plus `saveData` / Poor-quality auto-suggest | DATA-02, UX-01 | 2–3 days |
| 10 | CI media smoke test (LiveKit + 3 headless clients) | TEST-01 | 2 days |

## What could not be verified here
- **Runtime media measurements** (bitrate, CPU and RAM per student, latency): the container has no Docker daemon, initialising a local Postgres as a separate user was refused by the environment's permission policy, and running a downloaded LiveKit binary was also refused. Next step: run `scripts/loadtest` and the harness described in PERFORMANCE_BENCHMARKS.md on a staging VM.
- **Android/Windows device profiling** (no devices or emulators). Next steps are listed in each platform report.
- **Integration tests** (they need Postgres).

## Report index
See `README.md` in this directory.

# Feature and Functionality Audit

Method: route, API and library tracing; unit tests (598 pass, measured). Flows were **not** exercised end to end in a browser (no database available; see PERFORMANCE_BENCHMARKS §3).

## 1. Feature inventory

| Feature | Present | Implementation (entry points) | Status |
|---|---|---|---|
| Registration | Removed by design | `/register` redirects to `/login` | Staff are created by an admin |
| Staff login / logout | Yes | `api/auth/login`, `logout`, `me`, `status` | Throttled; single session |
| Password change / forced change | Yes | `api/auth/change-password`, `/account/password` | — |
| Password recovery (self-service) | **No** | Admin `teachers/[id]/reset-password` only | Expected for staff; acceptable for a school with an admin |
| Student join (school app) | Yes | `/join?t=` signed or unsigned params → `api/student/join` | SEC-02 |
| Student join (name form, temporary) | Yes | `/join-class`, `api/join-class` | SEC-02/03, UX-02 |
| Manual code + name join | Dev only | `ALLOW_MANUAL_STUDENT_JOIN=false` | — |
| Profiles / settings | Minimal | Teacher gender (salutation), password | — |
| Courses / enrollment | **Not a concept** | Grade × division × campus master + timetable instead | Fits a school |
| Scheduling (timetable, overrides, extra classes) | Yes | `admin/timetable/*`, `lib/schedule*.ts`, clash detection | Unit-tested |
| Live class | Yes | `/classroom/[code]`, `rooms/[code]/*` | Core |
| Waiting room / admit / admit all | Yes | `rooms/[code]/admit` | — |
| Audio / video / selective sample | Yes | `lib/sample.ts`, `token` | Server-enforced |
| Mute / mute all / per-student unmute allow / mic slots | Yes | `mute`, `mic`, `micSlotService.ts` | — |
| Screen share (+ video mode, HUD, annotate) | Yes (teacher) | `ClassroomRoom.tsx`, `TeacherShareHud.tsx` | — |
| Whiteboard (pages, shapes, PDF/image, export) | Yes | `lib/whiteboard/*`, `api/rooms/[code]/whiteboard` | Also in Android/Windows |
| Student drawing on share (request/allow, 3 min) | Yes | `draw`, `drawServer.ts` | — |
| Chat (student→teacher, broadcast, DM, replies) | Yes | `messages`, `messages/stream`, `chatThread.ts` | No student↔student chat by design |
| Raise hand | Yes | `hand` | SEC-04 (no rate limit) |
| Spotlight / pin student | Yes | `spotlight`, `pin-student`, `sample/pin` | — |
| Focus / attention status | Yes | `focus`, `lib/focusStatus.ts` | — |
| File sharing | **No** (only whiteboard image/PDF import by the teacher) | — | Missing for homework distribution |
| Attendance (auto, from webhooks) | Yes | `attendanceQueue.ts`, `attendanceService.ts`, reports + CSV | Integration tests exist |
| Recording / playback | **No** (by design) | — | Product decision; note the data cost if added |
| Notifications | In-app only (Android notifications for waiting/share) | — | No email/push to students |
| Assignments / assessments / quizzes | **No** | (The AI-teacher MCP has polls) | Missing for an LMS; out of current scope |
| Learning progress | **No** | — | — |
| Reports / analytics | Yes | `admin/reports/[kind]`, `admin/performance`, teacher ranking, class feedback | — |
| Payments / subscriptions | **No** | — | Not applicable |
| Organisation management | Yes | Campuses, grades, divisions, academic years, school settings | — |
| Admin: teachers, sub-admins, privileges, students import | Yes | `admin/*` | — |
| Admin live overview / observe / end class | Yes | `admin/live/*` | Hidden observer |
| AI teacher | Yes (separate app) | `apps/ai-teacher` (MCP tools) | Not deeply audited |
| Device takeover (one device per student/teacher) | Yes | `deviceTakeover*.ts` | — |

## 2. Correctness observations
- **Frontend/backend consistency:** strong. Pure `*Logic.ts` modules are shared and unit-tested; server grants are the source of truth and the UI mirrors them.
- **Concurrency:** Redis locks (`redisLock.ts`, `leaderLock.ts`) for jobs; attendance is queued and batched; unique constraints on `(classSessionId, studentId)`.
- **Edge cases handled (from code and tests):** teacher absent → students' mics locked; device switch; duplicate tabs; teacher re-entering after Leave; webhook queue overflow (2,000-join test).
- **Confirmed minor bug:** CQ-03, where the end screen may show generic copy when `endedBy` arrives late.
- **Risk:** Windows teacher app missing the Nov 25 mic fixes (REL-02).

## 3. Missing for a production-grade school platform (prioritised for this product)
1. Authenticated student identity (SEC-02), which is required.
2. Backups (INF-01).
3. Homework/file distribution: optional, and a small scope (teacher uploads, student downloads, offline access). Keep files small and cached.
4. Notifications for upcoming classes (the school app may already do this; verify before building).
5. Recording or lesson notes for absent students: consider an **audio + whiteboard-ops recording** (tiny: whiteboard ops are vector data, audio ~15 MB/h) instead of video.

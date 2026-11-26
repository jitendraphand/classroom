# Findings Register

Audit date: 2026-11-26. Code audited: `main` @ `d9aa9a0`, `android` @ `668ef56`, `windows` @ `5f707ea`.

Evidence labels: **Confirmed** (verified in code or by a command I ran) · **Measured** (number from a run in this audit) · **Inferred** (follows from code and SDK defaults, not run on a device) · **Not verified** (risk only).

Severity: CRITICAL / HIGH / MEDIUM / LOW, as defined in the audit brief.

## Summary table

| ID | Sev | Category | Platform | Title | Evidence |
|---|---|---|---|---|---|
| SEC-01 | CRITICAL | Security / deps | Backend | Next.js 15.5.27 has a published critical advisory (image optimizer RCE) plus 4 others | Confirmed (`npm audit`) |
| SEC-02 | HIGH | Security / authN | Backend, Web | Student identity is unauthenticated by default: unsigned SID links plus the name-only "Join the class" form | Confirmed |
| REL-01 | HIGH | Reliability / network | All | No TURN relay by default; students on UDP-restricted networks get no media | Confirmed |
| DATA-01 | HIGH | Bandwidth / battery | Web (students) | Students keep receiving video in background tabs (`pauseVideoInBackground: false`) | Confirmed |
| DATA-02 | HIGH | Bandwidth / UX | Web (students) | No true audio-only mode and no automatic downgrade on weak links | Confirmed |
| REL-02 | HIGH | Cross-platform drift | Windows | 5 shared modules have drifted from `main`, including the Nov 25 mic/echo fixes | Measured (diff) |
| TEST-01 | HIGH | Testing | All | No automated end-to-end, real-media, or weak-network tests in CI | Confirmed |
| SEC-03 | MEDIUM | Abuse / data growth | Backend | Unthrottled creation of student records through `/api/join-class` | Confirmed |
| SEC-04 | MEDIUM | Abuse | Backend | 80 of 85 API route files have no rate limiting (hand, draw, heartbeat, feedback…) | Confirmed |
| SEC-05 | MEDIUM | DoS / deps | Backend | No request-body size cap on route handlers; zod 3.x advisory | Confirmed (cap); Not verified (exploit) |
| PERF-01 | MEDIUM | Web perf | Web (students) | Classroom route ships 1,294 KiB raw / 365 KiB gzip JS, including teacher-only modules | Measured |
| PERF-02 | MEDIUM | Web perf / data | Web | Web fonts are 36% of first-visit transfer (80 of 221 KiB) | Measured |
| PERF-03 | MEDIUM | Device CPU / battery | Android (teacher) | Dynacast and adaptiveStream are not enabled | Inferred |
| PERF-04 | MEDIUM | Device CPU / idle | Windows (teacher) | Global no-throttle switches keep every window and timer at full rate even when idle | Confirmed |
| REL-03 | MEDIUM | Cross-platform drift | Android | Hand-ported Kotlin logic has no automated contract/drift check | Confirmed (by doc) |
| REL-04 | MEDIUM | Compatibility | Web (iOS) | VP9 share fallback for non-VP9 subscribers is not working on LiveKit 1.13.9 | Not verified (repo note) |
| UX-01 | MEDIUM | UX | Web (students) | Students have no network-quality indicator or a "switch to audio" prompt | Confirmed |
| UX-02 | MEDIUM | UX / data integrity | Web (students) | Name-based identity on `/join-class`: typos create duplicate students; same-name classmates share a seat | Confirmed (documented limit) |
| INF-01 | MEDIUM | Infra | Backend | No database backup/restore tooling or documented RPO/RTO | Confirmed (absence) |
| INF-02 | MEDIUM | Observability | Backend | No metrics or error tracking (LiveKit Prometheus off, no APM) | Confirmed (absence) |
| CQ-01 | MEDIUM | Maintainability | Web, Android, Windows | Very large files: `ClassroomRoom.tsx` 4,817 lines / 44 effects, `main.ts` 2,710, `classSession.ts` 2,550, `MainActivity.kt` 2,453 | Measured |
| PERF-05 | LOW | Device battery | Web (students) | A student's camera hardware stays on for self-preview when not in the visible sample | Confirmed (by design) |
| PERF-06 | LOW | Server | Backend | Teacher `/state` loads the room twice when the state cache is on | Confirmed |
| PERF-07 | LOW | Server / DB | Backend | Join form seeds the master lists (≥2 queries) on every POST | Confirmed |
| PERF-08 | LOW | DB | Backend | Retention sweep filters on `leftAt`, which has no index | Confirmed |
| PERF-09 | LOW | Device RAM / CPU | Windows | A second WebRTC stack (Rust sidecar) runs during a share | Confirmed (design) |
| SEC-06 | LOW | Security | Android | `cleartextTrafficPermitted="true"` for all hosts at OS level (the app checks addresses itself) | Confirmed |
| SEC-07 | LOW | Privacy | Backend | Chat rows stay in the database until the teacher's next class | Confirmed |
| SEC-08 | LOW | Security | Backend | 90-minute LiveKit token TTL widens the window for a leaked token | Confirmed (trade-off) |
| SEC-09 | LOW | Build-time dep | Backend | `source-map-js` advisory (postcss, build time only) | Confirmed |
| CQ-02 | LOW | Docs drift | Docs | README media table, `videoQuality.ts` header and the Windows TURN claim contradict the code | Confirmed |
| CQ-03 | LOW | Correctness | Web | Missing hook dependency `state?.endedBy` (`ClassroomRoom.tsx:1212`) | Confirmed (lint) |
| CQ-04 | LOW | Maintainability | Web | Tests named after review rounds (`round6`, `run3Fixes`, `todo1023`); deprecated aliases kept | Confirmed |

**Totals: 33 findings: 1 critical, 6 high, 14 medium, 12 low.**

## Fix status (2026-11-26, commit on `main`)

| ID | Status | What changed |
|---|---|---|
| SEC-01 | **Fixed** | next 15.5.29 (eslint-config-next too); `images: { unoptimized: true }` → `/_next/image` returns 404 (checked on the built server) |
| SEC-09 | **Fixed** | `source-map-js` overridden to ^1.2.2 (1.2.4 installed) |
| DATA-01 | **Fixed** | Students stop receiving teacher camera and share after the page has been hidden 20 s (`BACKGROUND_VIDEO_PAUSE_MS`); audio untouched; control goes back to adaptiveStream on return (`lib/videoEnable.ts`) |
| DATA-02 | **Mostly fixed** | New "Audio only" step (no camera, no share; whiteboard still shows); start mode from Save-Data / 2G / 3G. *Open:* the auto-suggest on a Poor link (goes with UX-01) |
| SEC-04 | **Fixed** | Per-student limits: hand toggles 30/min, draw request/cancel 20/min → 429 |
| SEC-05 | **Mostly fixed** | Content-Length cap in middleware (1 MiB, 8 MiB for whiteboard and roster import) → 413; Caddy `request_body max_size 8MB` (template and generator). *Open:* zod 4 migration |
| SEC-03 | **Fixed** | New `WEB-` students capped per class per day (`NEW_NAME_JOINS_PER_CLASS_PER_DAY`, default 150) |
| SEC-02 | **Partly fixed** | `ALLOW_NAME_JOIN=false` turns off the form (button, page, API); a start-up warning in production while students are not authenticated. *Not changed:* the default mode is still `unsigned` and the form is still on, so the school's current joining keeps working. Switching to signed is your call |
| PERF-07 | **Fixed** | `ensureJoinAudienceCached()`: master lists re-checked at most every 10 min per worker on request paths |
| PERF-08 | **Fixed** | `Participant @@index([status, leftAt])` + migration `20261126120000_participant_left_at_index` |
| SEC-07 | **Fixed** | Retention job deletes chat of ENDED classes older than `CHAT_RETENTION_HOURS` (default 24) |
| INF-01 | **Fixed (tooling)** | `scripts/backup-db.sh` (validated `pg_dump -Fc`, rotation, optional off-box copy, guarded restore); README "Backups". *You still need to:* add the cron line and an off-box target |
| INF-02 | Partly | LiveKit `prometheus_port` documented in the template; no metrics stack added |
| CQ-02 | **Fixed on main** | README media table and Node version, `videoQuality.ts` header. The Windows README is on the `windows` branch |
| CQ-03 | **Fixed** | `state?.endedBy` added to the dependencies (the handler only sets state, so a second call is harmless); lint now shows 0 warnings |
| UI (reduced motion) | **Fixed** | `prefers-reduced-motion` in `globals.css` (canvas laser and whiteboard unaffected) |
| REL-02, PERF-03, PERF-04, REL-03, SEC-06, PERF-09 | Not changed | They live on the `windows` / `android` branches, outside "commit to main" |
| REL-01 | Not changed | TURN needs a hostname, a certificate and firewall changes on your server |
| PERF-01, PERF-02, UX-01, UX-02, REL-04, TEST-01, CQ-01, CQ-04, PERF-05, PERF-06, SEC-08 | Not changed | Larger work, design decisions, or need devices/infrastructure (see IMPROVEMENT_ROADMAP.md) |

Verification: 611/611 unit tests (598 existing, 2 updated for the new behaviour, 13 new in `tests/auditFixes.test.ts`), `tsc` clean, `eslint` 0 errors and 0 warnings, `next build` OK, `shellcheck -S warning` clean on every script. Spot checks on the built server: 2 MB POST → 413; `/_next/image` → 404; `ALLOW_NAME_JOIN=false` hides the button, and `/join-class` and `/api/join-class` → 404. **Not run:** integration tests (no Postgres here) and the new migration against a real database (CI runs both).

---

## Detailed findings

### SEC-01: Vulnerable Next.js version (CRITICAL)
- **Files:** `apps/web/package.json:28` (`"next": "15.5.27"`), `apps/web/next.config.mjs` (no `images` block), `apps/web/public/favicon.svg`
- **Current:** next 15.5.27 is pinned.
- **Problem / evidence:** `npm audit --omit=dev` (run in this audit) reports:
  - GHSA-2464-fhr4-w9xw, *critical*: unauthenticated RCE in the Image Optimization API when SVG files are used (≤15.5.27)
  - GHSA-p3m5-59mp-jv5r, high: DoS in the App Router using Server Actions
  - GHSA-7qx7-33qx-rqx2, GHSA-f3mh-rxg3-f5g2 and GHSA-pc58-hwjq-p385, moderate
  The app never uses `next/image`, but `/_next/image` is served by default, and there is an SVG in `public/`.
- **Impact:** possible remote code execution on the single VM that holds Postgres, Redis, LiveKit keys and student data.
- **Exploitation:** an unauthenticated request to `/_next/image` with crafted parameters, per the advisory. *Exploitability against this deploy: Not verified.*
- **Fix:** bump to `next@15.5.29` or later, and add `images: { unoptimized: true }` to `next.config.mjs` (the optimizer is not used). Optionally block `/_next/image` in Caddy.
- **Savings / UX:** none (security). **Complexity:** low. **Regression risk:** low (patch release).
- **Tests:** `npm audit` clean in CI; `curl /_next/image?url=/favicon.svg&w=64&q=75` returns 400/404 after the change.

### SEC-02: Unauthenticated student identity by default (HIGH)
- **Files:** `apps/web/src/lib/schoolJoin.ts:25` (`unsigned` unless `SCHOOL_JOIN_MODE=signed`), `apps/web/src/lib/joinClassForm.ts:1-36`, `apps/web/src/app/api/join-class/route.ts`, `apps/web/src/app/page.tsx:15-18`, `apps/web/src/lib/schoolJoin.ts:137-140` (per-IP limit is 0 = off by default)
- **Current:** (a) a plain link `/join?FirstName=…&SID=…&Grade=…&Division=…` signs in as that SID; (b) the homepage "Join the class" form signs in as *any typed name* in any chosen grade, campus and foundation. The README says so itself ("anyone with a student's SID can join as them").
- **Impact:** attendance fraud (a friend "attends" for an absent student); seat takeover, since one device per student means joining as a classmate kicks them; strangers joining a minor's class. That last one is the main child-safety exposure.
- **Mitigations already present:** waiting room and teacher admission; per-SID throttle (6/min); unsigned links cannot rewrite records (`SCHOOL_JOIN_UNSIGNED_UPDATES=false`); `STUDENT_REGISTRY=auto` becomes strict after a roster import.
- **Fix:** (1) make `signed` the default when `NODE_ENV=production`, and log loudly at boot when it is unsigned; (2) put `/join-class` behind an explicit `ALLOW_NAME_JOIN=true` flag that defaults off, and remove it once the school app is integrated (as its header plans); (3) when name-join is on, require roster-strict mode (refuse names not on file); (4) set a non-zero default for `JOIN_RATE_LIMIT_PER_MINUTE` (for example 60 per IP: a school NAT still fits).
- **Complexity:** low–medium. **Regression risk:** medium (the school's current joining flow depends on the form; coordinate the switch).
- **Tests:** an unsigned link returns `unsigned_disabled` in prod mode; `/join-class` returns 404 when the flag is off; an unknown name is refused in strict mode.

### REL-01: No TURN relay by default (HIGH)
- **Files:** `infra/livekit.example.yaml:387-398` (the `turn:` block is commented out), `README.md` "Known limitations" ("No built-in TURN"). The Windows branch README (line ~99) says the opposite: "It bundles STUN and TURN on the same RTC ports, so a separate TURN deployment is not required."
- **Problem:** media needs UDP 50000–60000 or TCP 7881 to the SFU. School, office and public Wi-Fi often allow only 80/443. Those students connect to signaling (wss over 443) and then fail ICE: they see "Connecting / Reconnecting" with no audio.
- **Impact:** total class failure for the affected students. This is exactly the "unstable or restricted network" population the platform targets.
- **Fix:** enable LiveKit's embedded TURN with TLS on 443 on a second hostname or IP (or on 5349 where allowed), as the commented block already sketches. Restart LiveKit on certificate renewal, or terminate TLS for TURN at Caddy with layer-4 proxying. Correct the Windows README.
- **Cost:** TURN/TLS relays only the affected students. Bandwidth is the same as direct; CPU is slightly higher for TLS.
- **Tests:** a Playwright client with `iceTransportPolicy: 'relay'` and UDP blocked by iptables in a staging VM joins and receives audio.

### DATA-01: Video keeps flowing to students' background tabs (HIGH)
- **File:** `apps/web/src/components/classroom/ClassroomRoom.tsx:4558`: `adaptiveStream: { pauseVideoInBackground: false, … }`
- **Current:** chosen on purpose so that returning to the tab never shows a frozen share.
- **Problem:** a student who switches apps on a phone, or minimises the browser, keeps downloading the screen share (estimated 0.3–1.5 Mbps) and the teacher camera (≈0.06–0.3 Mbps), and keeps decoding them.
- **Estimate (from encoder caps, not measured):** 135–675 MB per hour of background time on screen-share lessons, plus the battery spent on decode.
- **Fix:** for students, pause video subscriptions after the page has been hidden for about 20 s (keep audio), and resume on `visibilitychange`. Show a "Resuming…" blur on the last frame. LiveKit resumes a layer within one keyframe (VP9 `_KEY` mode already gives keyframes on demand). Teachers keep the current behaviour.
- **Complexity:** low (one option plus a visibility hook). **Regression risk:** low–medium (a brief resume delay).
- **Tests:** Playwright: hide the page (`page.evaluate(() => document.dispatchEvent(...))` plus CDP `Emulation.setFocusEmulationEnabled`), then assert inbound-rtp `bytesReceived` for the video stops growing while audio continues.

### DATA-02: No audio-only mode, no automatic downgrade (HIGH)
- **Files:** `apps/web/src/lib/dataSaver.ts:1-45` (modes `off` / `low` / `share-only`; the most frugal still receives the screen share), and no use of `navigator.connection.saveData` / `effectiveType` anywhere (grep).
- **Problem:** on 2G/3G or a nearly used-up data pack, the share is the largest stream and cannot be turned off. The mode is manual only: a student on a "Poor" link is never offered a lower mode.
- **Fix:** add an "Audio only" step. It unsubscribes the share and the camera, and shows a still image of the current slide refreshed every N seconds through a low-fps layer: VP9 L2T3 already lets the SFU forward the lowest temporal layer, or a 1-fps subscription. Pick the starting mode from `navigator.connection.saveData` and `effectiveType` where available. Offer a toast after sustained `ConnectionQuality.Poor` for the local participant.
- **Expected saving:** audio-only ≈ 15–30 MB/h, against ≈ 160–700 MB/h for share lessons (estimates).
- **Complexity:** medium. **Regression risk:** low.

### REL-02: Windows app has drifted from `main` (HIGH)
- **Evidence (measured):** byte comparison of `windows:src/shared/web/*` against `main:apps/web/src/lib/*`: 24 of 29 copies are identical apart from the generated header; 5 differ:
  - `audioPolicy.ts` (33 lines): `micPublishAllowed` and `ownMicCurrent` from the Nov 25 echo audit are missing
  - `audio/voiceProcessor.ts` (26) and `audio/voiceSettings.ts` (24)
  - `classFinish.ts` (12): the "Class ended by admin" copy is missing
  - `whiteboard/WhiteboardBoard.tsx` (19)
- **Impact:** the Windows teacher app lacks the "grant-aware unmute" and "no untracked mic" fixes (commit `4ec4651`), so it can hit the publish-refused and echo issues that `main` fixed. Its `tests/webSync.test.ts` will fail on the next CI run against `main`.
- **Fix:** run `scripts/sync-web.mjs`, port any call-site changes from `SelectivePublisher.tsx`, and release 1.2.1. Make the Windows sync job run on every push to `main` (cross-repo dispatch) so drift is caught the same day.
- **Complexity:** low–medium. **Regression risk:** medium (audio path).

### TEST-01: No automated E2E, real-media or weak-network tests (HIGH)
- **Files:** `.github/workflows/ci.yml` (typecheck, lint, unit, 4 integration files, build, image). `docs/E2E_CHECKLIST.md` is manual. `scripts/loadtest/` is manual.
- **Measured:** 598 unit tests pass in 10.8 s; integration tests could not run here (no Postgres; see PERFORMANCE_BENCHMARKS.md).
- **Problem:** the core product (join → admit → hear teacher → see share → reconnect) is never exercised automatically. Media regressions (codec, grant, subscription) surface only in classes.
- **Fix:** see TESTING_RELIABILITY_AUDIT.md. In short: one CI job with LiveKit, Postgres and Redis service containers plus 2–3 headless Chromium clients with fake media, asserting audio and video `bytesReceived` > 0, with a second pass under `tc netem` loss/latency.

### SEC-03: Unthrottled student-record creation (MEDIUM)
- **Files:** `lib/joinClassForm.ts` header (a new name becomes `WEB-<hash>`), `lib/studentService.ts:43-63` (`auto` is open until a roster import), `lib/schoolJoin.ts:137-140`.
- **Problem:** before any roster import, every distinct typed name creates a Student row; the per-IP limit is off and the per-SID limit does not apply to new names. A script can fill the student list and attendance reports with junk.
- **Fix:** per-IP limit on by default; require a roster import (strict) before enabling name-join; cap new `WEB-` students per class per day.

### SEC-04: Rate limiting covers 5 of 85 route files (MEDIUM)
- **Evidence:** `grep` for limiter calls in `app/api/**/route.ts`: login, messages, join-class, client-error, student/join.
- **Problem:** `/hand` (each toggle pushes a LiveKit data packet to the teacher: `hand/route.ts:64,79`), `/draw`, `/feedback`, `/heartbeat`, `/state` and the admin routes are unbounded per user. A student can flood the teacher's client with hand toggles.
- **Fix:** one middleware-level token bucket per (session, route group), for example 30/min for hand and draw requests and 10/min for feedback, using the existing `overRateLimit`.

### SEC-05: No body-size limit; zod advisory (MEDIUM)
- **Files:** route handlers call `req.json()` without a size check. `infra/Caddyfile` has no `request_body { max_size }`. zod 3.25.76 is affected by GHSA-mrhx-c7xc-m3w5 (<4.6.6).
- **Problem:** an unauthenticated POST of a large JSON body to any route is fully buffered and parsed by a web worker. Several routes parse before authenticating (for example `join-class/route.ts:22`).
- **Fix:** add `request_body { max_size 256KB }` in Caddy (larger only for the whiteboard image routes), and an early `content-length` check in middleware. Plan the zod 4 migration.

### PERF-01: Large classroom bundle, teacher code shipped to students (MEDIUM)
- **Evidence (measured, production build):** `/classroom/[code]` loads 11 JS files, **1,294 KiB raw / 365 KiB gzip**. `/admin/live/[code]` loads 1,346 / 383 KiB. Other routes are 351–398 KiB raw / 104–119 KiB gzip. The largest chunk (`144d3bae…`, 531 KiB raw) is livekit-client.
- **Problem:** `ClassroomRoom.tsx` imports `TeacherShareHud`, `TeacherPeersFloat`, `AnnotateTools`, `TeacherInk`, the whiteboard editor and `ShareDrawing` statically. Only `Chat` is `next/dynamic` (`ClassroomRoom.tsx:76`). Every student downloads, parses and compiles teacher-only code. On a 4× CPU-throttled phone, parsing and compiling about 1.3 MB of JS costs on the order of 1–2 s (estimate; see PERFORMANCE_BENCHMARKS.md).
- **Fix:** `next/dynamic` for the teacher-only components, loaded under `isTeacher`. Expect roughly 15–30% less route JS for students (estimate; verify with `@next/bundle-analyzer`).
- **Complexity:** low–medium. **Regression risk:** low.

### PERF-02: Web fonts are 36% of first-visit bytes (MEDIUM)
- **Evidence (measured):** a cold `/login` transfers 221 KiB in 16 requests; two woff2 files are 48 KiB + 32 KiB (Inter + Outfit, `app/layout.tsx:2-16`).
- **Fix:** use the system UI font stack for body text and keep one display font (or none) for headings; `display: 'swap'` is already set. Saves about 30–80 KiB per new device.

### PERF-03: Android teacher app without dynacast (MEDIUM)
- **File:** `apps/android/app/src/main/java/com/classroom/teacher/MainActivity.kt:716-724`: `LiveKit.create(applicationContext, overrides = …)` with no `RoomOptions`. No `dynacast` or `adaptiveStream` appears anywhere in `apps/android` (grep).
- **Inferred:** the LiveKit Android SDK defaults `dynacast = false` and `adaptiveStream = false`. The phone therefore encodes every simulcast layer of the camera (360p + 180p) and the screen share (top + 720p) all the time, even when nobody subscribes to a layer. Web (`ClassroomRoom.tsx:4560`) and Windows (`classSession.ts:477`) enable dynacast.
- **Impact:** extra encoder CPU, heat and battery on the teacher's phone, and extra uplink. The teacher's uplink is the single point every student depends on.
- **Fix:** `LiveKit.create(context, options = RoomOptions(dynacast = true, adaptiveStream = true), overrides = …)`. **Verify** with Android Studio's Energy/CPU profiler before and after.

### PERF-04: Windows: global "never throttle" switches (MEDIUM)
- **File:** `windows:src/main/main.ts:148-149` (`disable-renderer-backgrounding`, `disable-background-timer-throttling`) and `:754` (`backgroundThrottling: false`).
- **Problem:** these are needed while a share runs from a minimised window. But they are process-wide and permanent: they also apply on the sign-in screen, the dashboard, and in the tray between classes.
- **Fix:** keep `backgroundThrottling: false` only on the publisher window during a share (`webContents.setBackgroundThrottling(false)` when the share starts, `true` when it stops), and drop the two global switches if the WGC sidecar path no longer depends on them. **Measure** idle CPU in Task Manager before and after.

### REL-03: Android port has no drift check (MEDIUM)
- **Evidence:** `apps/android/COMPATIBILITY.md`: "there is no automatic drift check as on Windows". `WebParityTest.kt` covers whiteboard parity only.
- **Fix:** golden JSON fixtures for `/state`, `/token` and the data-packet topics, generated from `main` tests and asserted by both Kotlin and TS tests.

### REL-04: iOS/older-Safari share fallback (MEDIUM, Not verified)
- **File:** `apps/web/src/lib/videoQuality.ts:58-70`: "with LiveKit 1.13.9 a subscriber that declines VP9 … did NOT get the backup started".
- **Risk:** a student device that cannot decode VP9 may receive no screen share.
- **Next step:** test on an iPhone running iOS 15/16 and on an older Android WebView. If it fails, publish VP8 simulcast for those classes (or always, at about 30% more bits).

### UX-01: No student network indicator (MEDIUM)
- **Evidence:** the only student network feedback is the "Reconnecting to class…" pill (`ClassroomRoom.tsx:4597-4601`). `ConnectionQualityChanged` is used only on the teacher's side for students (`:857`).
- **Fix:** a three-bar indicator for the local participant; on Poor for more than 15 s, suggest "Switch to audio only".

### UX-02: Name-based identity (MEDIUM)
- Documented in the `joinClassForm.ts` header: a typo creates a second record, and two classmates with the same name share one seat (the second kicks the first). Prefer roll number plus name, or a per-class 4-digit PIN shown by the teacher.

### INF-01: No backups (MEDIUM)
- Nothing in `scripts/` runs `pg_dump`, and the docs give no RPO/RTO. Attendance is the system's legal record.
- **Fix:** a nightly `pg_dump -Fc` to off-box object storage with 14-day retention, plus a documented restore drill. Costs cents per month.

### INF-02: No metrics (MEDIUM)
- There is no `prometheus_port` in the LiveKit template and no error tracker (only `/api/client-error` to logs).
- **Fix:** enable LiveKit `prometheus_port` and scrape with a small VictoriaMetrics or Prometheus instance (about 100 MB of RAM). Alert on egress, packet loss, participant count and web 5xx.

### CQ-01: God files (MEDIUM)
- `ClassroomRoom.tsx` has 4,817 lines, 37 `useState` and 44 `useEffect`. The splitting has started (StudentMediaPrivacy, SelectivePublisher); keep extracting by role (student shell versus teacher shell), which also enables PERF-01.

### LOW findings (short form)
- **PERF-05:** the student camera stays open for self-preview while not published (`SelectivePublisher.tsx:52-58`). Stop the device when the preview is minimised and the student is not in the sample.
- **PERF-06:** `state/route.ts:64` then `:90`: the teacher triggers `loadRoom` twice when `STATE_CACHE_MS > 0`. Skip the memo when `isTeacher` is already known from the cookie.
- **PERF-07:** `join-class/route.ts:18`: `ensureJoinAudience()` (2+ queries, possible writes) runs on every POST. Run it once at boot (it already does) and cache the "nothing to add" result.
- **PERF-08:** `retention.ts:27-31` filters on `role, status, leftAt` with no `leftAt` index. Add a partial index `(leftAt) WHERE status='LEFT'`.
- **PERF-09:** the Windows Rust sidecar (`native/share-sidecar`, livekit-rust 0.9) is a second WebRTC participant during a share. It is justified by capture exclusion; measure RAM/CPU on a 4 GB laptop.
- **SEC-06:** `network_security_config.xml` permits cleartext to every host; restriction relies on the app-level check in `ClassLogic.kt:234-256`. Acceptable, but consider `domain-config` for the RFC1918 ranges only, which the OS cannot express for IP ranges. Keep it as is and document it.
- **SEC-07:** chat rows are deleted only when the teacher's room reopens (`teacherRoom.ts:193`). Add an "ended > 24 h" purge to the retention job.
- **SEC-08:** `livekit.ts:34`: a 90-minute token TTL. Acceptable trade-off for reconnects; document it.
- **SEC-09:** `source-map-js` 1.2.1 through postcss is build time only. Update when postcss bumps.
- **CQ-02:** the README "Media quality" table (teacher 720p30 simulcast) contradicts `videoQuality.ts` (360p15 plus a 180p layer). The `videoQuality.ts:5-9` header says "L1T3" while the code uses `L2T3_KEY`. The Windows README claims TURN is bundled.
- **CQ-03:** `ClassroomRoom.tsx:1212`: `state?.endedBy` is missing from the dependencies. If `endedBy` arrives after `ENDED`, the end screen shows the generic copy.
- **CQ-04:** test files named after review rounds; `JOIN_CLASS_FIXED` and `resolveFixedClass` are kept only for old tests.

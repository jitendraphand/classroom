# Code review — 2026-10-27 (state of `main` @ `1799ea1`) and its fixes

This replaces the review of 2026-10-21 (`b5c6c32`). Its critical items had
already been fixed by `1799ea1`: camera/mic limits moved into the LiveKit grant,
10-minute tokens, migrations fail closed, and leaked secrets are refused.
This document lists what the second review found and what branch
`ccr-1b6fe3e9-fx7yb9` changed for each finding.

**How the fixes were verified**

- Typecheck, ESLint (new, clean) and 433 unit tests.
- 6 integration tests against a real Postgres 16 + Redis 7: class-end SQL,
  queue replay, concurrent flushers, concurrent admits under a cap, reports,
  retention.
- Migrations on an empty database, plus a schema/migration drift check.
- `next build`.
- Smoke runs of the built standalone server in the slim runtime layout:
  health trust, cross-site join refusal, client-error throttle, SIGTERM drain
  timing.

**Not verified here:**

- The Docker image build: no daemon in this environment. CI builds it.
- A live LiveKit end-to-end run.
- A load test.

CI (`.github/workflows/ci.yml`) runs all of the above on every PR, including
the image build.

## Found while fixing (not in the original report)

| | Finding | Fix |
|---|---|---|
| **Critical** | LiveKit treats `canPublish: true` with an **empty** `canPublishSources` as "every source allowed" (livekit-client mirrors the server rule). That was exactly the grant of a muted student outside the camera sample, i.e. most students: they could publish camera, microphone and even screen share. | `publishPermission()`: nothing allowed ⇒ `canPublish: false`; used by token grants and `updateParticipant` (`lib/livekit.ts`). Test in `tests/authz.test.ts`. |
| High | `AttendanceRecord.openSids` was NULL for records created on arrival, so the class-end "stamp leftAt where nothing is open" never matched the students who arrived but never connected (the documented "106 rows" fix did not work). | Migration backfills `{}` and sets a default; the stamp is NULL-safe SQL. |

## Findings from the review and their resolution

### High

1. **Students could draw / annotate without permission and rewrite anyone's
   strokes.** All students had `canPublishData`; receivers trusted any
   student packet whose `by` matched the sender.
   → Fixed: students have no data grant. Strokes, whiteboard ops, chat and
   hands go through the API, which checks the permission and stroke ownership
   and relays them as server packets. Receivers drop packets from student
   identities. (`lib/livekit.ts`, `lib/realtimePackets.ts`, `Whiteboard.tsx`,
   `ShareDrawing.tsx`, `chatThread.ts`, `draw` route.)
2. **Unsigned join links could rewrite or restore any student and kick them
   from class via a GET.**
   → Fixed:
   - Unsigned links only look up existing students; `SCHOOL_JOIN_UNSIGNED_UPDATES` opts back in.
   - A deleted student stays deleted.
   - Per-SID throttle (`JOIN_SID_RATE_LIMIT_PER_MINUTE`, 6).
   - `/join` is honoured only as a top-level navigation (Sec-Fetch-Dest/Mode).
   - Signed mode is recommended in the docs.
3. **N² LiveKit fan-out in permission pushes.** Every student update listed
   the whole room, unbounded, on teacher join/leave, mute-all and screen-share
   sidecar events.
   → Fixed:
   - One `PermissionContext` per batch.
   - The `updateParticipant` result supplies the tracks.
   - Bounded concurrency (`PERMISSION_PUSH_CONCURRENCY`).
   - The sidecar is not teacher presence.
   - A joining student is pushed to directly, without a room listing.
4. **Sample rotation made every student refetch `/state` every 8 s, with the
   full roster.**
   → Fixed:
   - Rotation nudges only the students who entered or left the sample.
   - No rotation while the video panel is hidden.
   - Students get a trimmed roster (teacher, on-screen students, themselves)
     plus `admittedStudentCount`.
5. **Admission was O(N²) and racy.**
   → Fixed:
   - Advisory-locked class-size cap (integration-tested with 6 concurrent admits).
   - Incremental Redis sets.
   - One `admittedAt` update per session.
   - Re-sample only with a free slot.
   - Admit nudges the teacher only.
6. **Attendance integrity.**
   - a/b. Reordered and replayed events: fixed with `closedSids`. Applying an
     event is now idempotent and order-tolerant per SID.
   - c. LTRIM-by-count races: fixed. A Lua claim moves the batch into an
     in-flight list under a renewed lock, and only the lock holder clears it.
     A leftover batch is replayed first.
   - d. Ack-then-lose: fixed. The webhook RPUSHes the attendance event before
     answering LiveKit, and returns 503 if neither Redis nor the DB takes it.
   - e. Per-student transactions at class end: fixed with two set-based SQL
     statements.

### Medium

7. **`cluster.js` respawned workers on SIGTERM and never exited.**
   → Fixed. Workers drain: they wait for in-flight requests and run shutdown
   hooks, bounded by `WEB_SHUTDOWN_GRACE_MS`. The primary exits with the last
   worker. One worker also runs supervised (heap cap, recycle, crash restart).
8. **Web on `0.0.0.0` and a client-controlled `X-Forwarded-For`.**
   → Fixed:
   - `WEB_HOSTNAME`: loopback behind Caddy, set by `configure-domain-tls.sh`.
   - cluster.js stamps the TCP peer on every request.
   - XFF is believed only from `TRUSTED_PROXIES` (loopback by default).
9. **Redis `allkeys-lru` could evict queue, locks and join markers.**
   → Fixed: `volatile-ttl`, AOF only.
10. **The global-version DB read cache rarely hit and added Redis round
    trips; Prisma `$use` is deprecated.** → Fixed: removed. Auth reads are
    direct indexed lookups.
11. **Mic queue read-modify-write races.** → Fixed: Redis lock
    (`updateMicBook`). Muted-set swaps are atomic. Mic requests nudge only
    the affected students.
12. **`/api/student/check` recomputed the school timetable per poll.**
    → Fixed: a per-worker memo (`STUDENT_SCHEDULE_CACHE_MS`, 10 s) and a 2 s
    live-room list.
13. **Every leave re-sampled and nudged everyone.** → Fixed: re-sample only
    when the leaver held a slot; nudge the teacher.
14. **Side-effecting GETs bypassed the CSRF guard.** → Fixed: API requests of
    any method declaring `Sec-Fetch-Site: cross-site/same-site` are refused.
    The join link is the one allowed cross-site navigation.
15. **Year-long reports held everything in memory with an
    O(sessions × students) scan.** → Fixed:
    - Sessions are paged with only the needed columns.
    - Students are indexed by campus|grade.
    - The per-student summary streams.
    - The event loop yields between pages.
16. **Unthrottled `/api/client-error` and no log rotation.** → Fixed: 8 KB
    body cap and 10/min per IP. json-file rotation on every container.
17. **No chat rate limit; no security headers.** → Fixed:
    - Chat: 5 messages / 10 s per student, 30 for the teacher.
    - nosniff, `frame-ancestors`/X-Frame-Options, Permissions-Policy,
      Referrer-Policy, no X-Powered-By.
    - HSTS in the Caddy templates.

### Low

- **Feedback double submit returned 500.** → Fixed: P2002 returns 409.
- **Rotation lock release.** → Fixed: compare-and-delete; no lock-less
  re-rotation.
- **Staff sessions lasted 7 days with client-only idle logout.** → Fixed:
  `TEACHER_SESSION_HOURS` (24) / `ADMIN_SESSION_HOURS` (12), sliding via
  `/api/auth/me`.
- **Duplicate `Participant.sessionToken` index.** → Fixed: dropped.
- **Participant rows grew forever.** → Fixed: leader-locked retention
  (`PARTICIPANT_RETENTION_DAYS`, 30).
- **`/api/health` leaked configuration.** → Fixed: status only for
  non-local callers.

### Maintainability

- **ESLint.** → Added (`next/core-web-vitals` + TypeScript), lint-clean.
  Fixing the warnings also turned up:
  - per-render teardown/re-add of LiveKit listeners (unstable identity arrays);
  - a lobby that kept polling after leaving.
- **CI.** → Added: typecheck, lint, unit, migration and drift check,
  integration (Postgres/Redis services), build, shellcheck, compose
  validation, resource-sizing dry runs, Docker image build.
- **`ClassroomRoom.tsx` (6,289 lines).** → Split into `participantRoles`,
  `StudentMediaPrivacy`, `localPublish`, `SelectivePublisher`,
  `TeacherPeersFloat` and `TeacherCameraFloat` (~4,280 lines left).
  **Still open:** `RoomInner` (~2,800 lines of shared state) needs a
  state-container refactor, which should be done with browser tests in place.
- **Tests.** → Source-reading tests read the whole classroom view through one
  helper. **Still open:** the batch-named test files (`round7`, `partBFixes`, …)
  are not reorganised, and the remaining source-text assertions are not
  rewritten as behaviour tests.
- **Dockerfile.** → `npm ci` (the lockfile is enforced) and production-only
  runtime dependencies (`node_modules` 694 MB → 238 MB).
- **Docs.** → README, CAPACITY, SCALING, DEPLOY-*, SCHOOL_APP_INTEGRATION and
  VERIFY updated. New: `docs/CONSTRAINED-DEPLOY.md`.

## Constrained-resource deployment (new)

- `scripts/configure-resources.sh` (`npm run tune`) sizes the stack for the
  host (vCPU, RAM, optional `EGRESS_MBPS` / `EXPECTED_STUDENTS`). It writes:
  - web workers and the Prisma pool;
  - Postgres memory and connections;
  - Redis maxmemory;
  - container memory limits (never on LiveKit);
  - `MEDIA_PROFILE`;
  - log rotation.
- `MEDIA_PROFILE=low` roughly halves the SFU egress per student: 180p
  teacher camera, 10 fps / 1 Mbps slides, 720p15 video mode, 100 kbps student
  cameras, students start in data saver.
- Compose defaults now fit a 2–4 GB box. Large boxes get their old values
  from the script.

## Behaviour changes operators should know

- Teacher sessions expire after **24 h without use** (was a fixed 7 days).
  Native apps that never call `/api/auth/me` re-login daily
  (`TEACHER_SESSION_HOURS` changes it).
- Unsigned join links no longer update student details. Use the admin CSV
  import or signed links (or `SCHOOL_JOIN_UNSIGNED_UPDATES=true`).
- Students' `/state` no longer contains the full class roster.
- Compose defaults: `POSTGRES_MAX_CONNECTIONS` 100 (was 400),
  `REDIS_MAXMEMORY` 256mb (was 1gb), `WEB_MEM_FRACTION` 0.35. Run
  `./scripts/configure-resources.sh` on big servers.
- Deploy the new migrations (`closedSids` + `openSids` backfill, duplicate
  index drop) with the code; the entrypoint does this
  (`prisma migrate deploy`).

## Still open

- Unsigned mode can still be impersonated by anyone who knows a SID. Only
  signed links fix that.
- `RoomInner` decomposition and a browser (Playwright) test suite for the
  classroom flows.
- A load test of the new fan-out paths at 1,000+ students (CAPACITY.md
  "unproven" list).

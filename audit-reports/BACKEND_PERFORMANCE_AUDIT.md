# Backend Performance Audit

## Architecture in brief
A Node cluster (`apps/web/cluster.js`) forks N workers sized to the CPUs and Postgres `max_connections`. Each worker has a heap cap and RSS-based recycling; workers run at `nice 5`; LiveKit gets `cpu_shares 8192` against the web tier's 512. This is well tuned for a shared single box.

## CPU
| Item | Evidence | Verdict |
|---|---|---|
| Hot endpoint `/state` | Student snapshot memoised per room version (`roomStateCache.ts`); a trimmed payload for waiting students (`state/route.ts:116-140`) | Good |
| Teacher `/state` | Loads the room twice when the cache is on (`state/route.ts:64` then `:90`) | PERF-06 (minor) |
| Fan-out | Nudges are targeted (`NudgeAudience`); permission pushes batched with bounded concurrency (README "Scale design notes") | Good |
| Webhooks | Acked at once, queued internally (`webhookQueue.ts`) | Good |
| bcrypt cost 12 on login | ~200–300 ms of CPU per login on one core (estimate) | Fine (staff only, throttled) |
| Join form | `ensureJoinAudience()` on every POST (`join-class/route.ts:18`) | PERF-07 |

## RAM
- Per-worker heap cap and RSS recycle (`cluster.js:897-942`); Next's in-memory cache is capped at 16 MB (`next.config.mjs`).
- Chat SSE uses one Redis subscriber per worker, not per viewer (`chatHub.ts`): a fix for an earlier connection leak.
- No unbounded in-process caches found (memo entries are keyed by room version with a TTL; not exhaustively verified).

## Database
- Indexes cover the hot paths: `Participant(roomId,status)`, unique `sessionToken` and `livekitIdentity`, `Message(roomId,createdAt)`, `AttendanceRecord(classSessionId,studentId)` unique, GIN on `campuses`. See DATABASE_AUDIT.md.
- Pool: `DB_POOL_PER_WORKER` auto-shrinks to fit `max_connections − 24` (`cluster.js:778-794`).
- N+1: `/state` uses one `findUnique` with `include` (participants + student) for the roster. That is one query, not N.
- Gap: no `pg_stat_statements` and no slow-query logging is configured, so there are no query timings. **Not measured.**

## API traffic per connected student (inferred from `pollPolicy.ts` and `studentPresenceLogic.ts`)
| Request | Rate (visible / hidden) |
|---|---|
| `/state` | 1/min (+ nudges spread over 3 s) / 0.5/min |
| `/messages` poll | 1/min while push is live |
| `/heartbeat` | 1 per 40 s + jitter |
| **Total** | ≈ 3.5 requests/min → 2,500 students ≈ 146 req/s baseline (estimate) |

## Background jobs
Leader-locked (`leaderLock.ts`): retention every 6 h, ranking hourly, attendance flusher, teacher presence tick (1 s), mic-slot sweeper. No duplicate-job risk across workers. The 1 s teacher-presence tick runs on one worker only (verify it does no DB work per tick when idle; not measured).

## Rate limits and timeouts
- Login, messages, join and client-error routes are throttled; the other routes are not (SEC-04).
- Node `requestTimeout = 0` (for SSE), so a slow-loris client is bounded only by `headersTimeout` (66 s) and Caddy's `read_header 15s` / `read_body 30s`. On bare-IP deploys without Caddy there is no body timeout (SEC-05).

## Recommendations (ordered)
1. SEC-05 body cap; SEC-04 route-group rate limits.
2. Enable `pg_stat_statements` and Prisma query logging in staging load tests; record the p95 per route in PERFORMANCE_BENCHMARKS.
3. PERF-06 / PERF-07 small fixes.
4. Export `/metrics` (request counts and latency per route, worker RSS, queue depth) for INF-02.

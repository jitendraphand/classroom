# Scaling the web tier (1,500-student classes)

Written after the 2026-10-24 trial (1,500 students, 64 vCPU / 48 GB): 1,390 HTTP 503s (mostly `/state`),
~70 Prisma "Transaction already closed" errors in the attendance webhook, 411 LiveKit `NegotiationError`s.

## 1. Server-pushed room state, cached `/state`
- Every change (`nudge`, mute, signals) bumps `roomver:{code}` in Redis and pushes a `cls-state` packet that carries `spread`.
- Students refetch after a random delay within `spread`, so 1,500 clients don't hit `/state` at once.
- The student path of `/state` memoizes the room row (by version), shared Redis/settings/whiteboard reads, and the admitted list for `STATE_CACHE_MS`.
- The teacher always gets fresh data. `me` and admission are computed per request.
- The token route reads participant status from the DB, so rejoining students still go through the waiting room.
- Fallback poll when push isn't live: 5 s (15 s when the tab is hidden). Waiting room: 3 s / 8 s. Both are jittered.

## 2. Batched attendance writes
- The LiveKit webhook appends events to the Redis list `att:events` and returns immediately. If Redis is down, it writes directly.
- One leader (`lock:attendance-flush`) flushes every `ATTENDANCE_FLUSH_MS` with a handful of queries per batch.
- Applied event ids are kept in `att:applied` (1 h), so a replay after a crash can't reopen a connection.
- Failed events are retried up to 5 times.
- Ending a class flushes the queue first, so feedback goes only to students present at the end.
- Joins at or after the end are ignored.

## 3. Quieter background traffic
- Heartbeat: every 40 s ± 10 s. A student shows as reconnecting after 105 s and stale after 140 s.
- Chat poll without push: 6 s (15 s hidden), jittered.
- `auth/me`: every 120 s, jittered. During a live class it runs every 10 min.

## 4. Join waves
- The token route gives each student a `connectDelayMs` slot from the Redis key `join:pace` (`JOIN_CONNECT_RATE` per second, at most `JOIN_SPREAD_MAX_MS`). Teachers get 0.
- The client waits for that delay before connecting.
- Mic and camera publishes retry negotiation timeouts twice with backoff, unpublishing between attempts.
- A first connect that fails with a negotiation or connection error triggers a rejoin with a fresh token.

## 5. Cores and connections
- `WEB_CPU_FRACTION` of CPUs go to web workers; the rest are left for LiveKit. Boxes with 8 or fewer CPUs use them all.
- Prisma pool: `DB_POOL_PER_WORKER`. Postgres `max_connections` is 400. Keep workers × pool below that, with headroom.

## Env vars
| Var | Default | Meaning |
|---|---|---|
| `WEB_CPU_FRACTION` | 0.5 | Share of CPUs for web workers (`WEB_WORKERS` still overrides) |
| `DB_POOL_PER_WORKER` | 10 | Prisma connections per worker |
| `POSTGRES_MAX_CONNECTIONS` | 400 | Postgres `max_connections` |
| `STATE_CACHE_MS` | 1000 | Student `/state` cache (0 = off, max 5000) |
| `STATE_PUSH_SPREAD_MS` | 3000 | Spread of student refetch after a push |
| `ATTENDANCE_FLUSH_MS` | 2000 | Attendance flush interval |
| `ATTENDANCE_FLUSH_BATCH` | 500 | Events per flush |
| `JOIN_CONNECT_RATE` | 40 | Student LiveKit connects per second |
| `JOIN_SPREAD_MAX_MS` | 15000 | Max join delay (0 = off) |

## Trade-offs
- Student state can be up to about 1 s stale.
- Attendance is written about 2 s late. Ending a class waits up to 8 s for the flush.
- A small replay window remains after a crash.
- 400 Postgres connections use more memory.
- Big boxes run fewer web workers.
- A join can be delayed up to 15 s.
- "Reconnecting" shows later (105 s).

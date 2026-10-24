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
- The token route gives each student a `connectDelayMs` slot from the Redis key `join:pace` (`JOIN_CONNECT_RATE` per second). Teachers get 0.
- The window grows with the room: `max(JOIN_SPREAD_MAX_MS, admitted / JOIN_CONNECT_RATE s)`, capped at `JOIN_SPREAD_CAP_MS`. At the defaults (30/s, 15 s, 90 s) a 1,500-student wave is spread over 50 s, not 15 s.
- The client waits for that delay before connecting.
- Mic and camera publishes retry negotiation timeouts twice with backoff, unpublishing between attempts.
- A first connect that fails with a negotiation or connection error triggers a rejoin with a fresh token (and a fresh pacing slot) after a backoff that grows with each failure in a row: 2, 4, 8, 16, 32, 45 s (50–100% jitter). A successful connect resets it.

## 5. Cores and connections
- `WEB_CPU_FRACTION` of CPUs go to web workers; the rest are left for LiveKit. Boxes with 8 or fewer CPUs use them all.
- Prisma pool: `DB_POOL_PER_WORKER`. Postgres `max_connections` is 400. Keep workers × pool below that, with headroom.

## 6. Web worker memory
- Web workers share `WEB_MEM_FRACTION` (default 0.5) of available RAM (the container's cgroup limit when lower). Each worker's recycle threshold is that share (512–4096 MB), and its V8 heap cap (`--max-old-space-size`) is 80% of it.
- 48 GB with 16 workers gives 1,536 MB RSS and a 1,228 MB heap. Before, it was 1,051 MB and 788 MB; trial 2 had 5 heap OOM restarts.
- Override with `WEB_WORKER_MAX_RSS_MB` (0 turns recycling off) or `WEB_WORKER_HEAP_MB`.
- The student `/state` memo is keyed by room version. Expired entries are now swept every second (max 256), so stale 1,500-row rosters don't pile up during the join ramp.

## 7. LiveKit CPU above ~1,200 students
Trial 2 ran 1,500 students on one Oracle A1 server (32 OCPU, 48 GB). LiveKit hit 1600–2200% CPU during the join ramp, and 83 bot connects timed out between 1,200 and 1,400 students. Most of that cost is the connect itself (ICE/DTLS handshakes and the first subscriptions). Steady state is much cheaper.

Options, cheapest first:
1. **Spread the ramp.** This is the default now (§4). For bigger rooms, lower `JOIN_CONNECT_RATE` to 20 so 1,500 students spread over 75 s, and raise `JOIN_SPREAD_CAP_MS` if needed.
2. **Give LiveKit more cores on the shared box.** On a 32-core box, the default `WEB_CPU_FRACTION=0.5` gives web 16 workers. Web peaked at about 1 core per worker, so set `WEB_CPU_FRACTION=0.375` (12 workers) or `WEB_WORKERS=12`, which leaves about 20 cores for LiveKit. For hard isolation, pin with `cpuset` in `docker-compose.yml`: LiveKit on cores 0–19, web/Postgres/Redis on 20–31. LiveKit already has `cpu_shares: 8192`, and web runs at `nice` `WEB_NICE` (5).
   - Rough sizing from trial 2: about 1.5 LiveKit cores per 100 students at peak join, and well under that once steady. For 1,500 students, plan for about 20 dedicated LiveKit cores.
3. **Second media node.** `docker-compose.media.yml` plus `LIVEKIT_SERVERS` (docs/MULTI-SERVER.md) runs LiveKit on a separate VM.
   - Rooms are assigned to a node whole. That moves all SFU CPU off the web box (best for one huge class), or splits *several* classes across nodes.
   - It does not split a single room across nodes. For one room well above ~2,000 students, use a bigger media VM. A 1,500-student room fits on one dedicated 16–32-core media VM.

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
| `JOIN_CONNECT_RATE` | 30 | Student LiveKit connects per second |
| `JOIN_SPREAD_MAX_MS` | 15000 | Minimum pacing window for small rooms (0 = pacing off) |
| `JOIN_SPREAD_CAP_MS` | 90000 | Max pacing window for big rooms (max 180000) |
| `WEB_MEM_FRACTION` | 0.5 | Share of RAM for all web workers (max 0.9) |
| `WEB_WORKER_MAX_RSS_MB` | auto | Per-worker recycle threshold (0 = off) |
| `WEB_WORKER_HEAP_MB` | auto (80% of RSS) | Per-worker V8 heap cap |

## Trade-offs
- Student state can be up to about 1 s stale.
- Attendance is written about 2 s late. Ending a class waits up to 8 s for the flush.
- A small replay window remains after a crash.
- 400 Postgres connections use more memory.
- Big boxes run fewer web workers.
- A join can be delayed up to 15 s in small rooms, and up to `JOIN_SPREAD_CAP_MS` (90 s) in big ones.
- "Reconnecting" shows later (105 s).

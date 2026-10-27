# Running on a small box (constrained CPU, RAM and network)

The whole stack — web (Next.js cluster), Postgres, Redis, LiveKit and Caddy —
runs on one VM. On a small VPS the order of what runs out is usually:
**uplink bandwidth → RAM → CPU**. This page is the checklist for those boxes;
[CAPACITY.md](CAPACITY.md) and [SCALING.md](SCALING.md) cover the big ones.

## 1. Size the stack for the host

```bash
./scripts/configure-resources.sh --print        # dry run: what it would set
./scripts/configure-resources.sh                # write it into .env
# with a known uplink and class size, it also picks the media profile:
EGRESS_MBPS=200 EXPECTED_STUDENTS=300 ./scripts/configure-resources.sh
docker compose up -d --force-recreate            # (or --profile tls)
```

It detects vCPUs and RAM and picks a profile (`RESOURCE_PROFILE=small|medium|large`
overrides it):

| Host | Profile | Web workers | Postgres | Redis | Container memory limits | Media |
|---|---|---|---|---|---|---|
| 2 GB / 1-2 vCPU | small | 1 | 128 MB buffers, ~30 connections | 96 MB | Postgres 410 MB, Redis 192 MB, web 600 MB, Caddy 128 MB | low |
| 4 GB / 2 vCPU | small | 2 | 256 MB buffers, ~34 connections | 128 MB | Postgres 768 MB, Redis 224 MB, web 1.25 GB, Caddy 128 MB | low |
| 8 GB / 4 vCPU | medium | 4 | 512 MB buffers, ~56 connections | 256 MB | Postgres 1.6 GB, Redis 352 MB, web 2.4 GB, Caddy 256 MB | standard |
| ≥ 16 GB or > 8 vCPU | large | auto (half the CPUs) | per CAPACITY.md | 1 GB | none | standard |

LiveKit never gets a memory limit: it is the one service that must not be
OOM-killed in the middle of a class. Everything else is capped so it cannot
starve it, and LiveKit also wins CPU contention (`cpu_shares`, `WEB_NICE`).
Below 2 GB RAM the script warns: that is not enough for all five services.

Inside a container limit the web workers size their heaps from that limit
(`WEB_MEM_LIMIT_FRACTION`, 85 % of it), and a single worker is recycled
stop-then-start, because there is no room for a second process beside it.

## 2. Bandwidth: the media profile

The SFU forwards the teacher's streams to every student, so the server's
**egress ≈ students × per-student bitrate**. `MEDIA_PROFILE` (in `.env`,
handed to every browser with its LiveKit token) sets what publishers send:

| | standard | low |
|---|---|---|
| Teacher camera | 360p15 ≤ 300 kbps + 180p layer | one 180p12 layer ≤ 120 kbps |
| Slides share | 15 fps, ≤ 2.5 Mbps top / 720p ≤ 1.2 Mbps | 10 fps, ≤ 1 Mbps / 720p ≤ 600 kbps |
| Video-mode share | 720p24 ≤ 1.5 Mbps | 720p15 ≤ 800 kbps |
| Student cameras | 320×180 ≤ 200 kbps | ≤ 100 kbps, 10 fps |
| Students start in | data saver off | data saver "Low quality" (they can change it) |

Resolution is never lowered for slides (text stays legible); frame rate and
bitrate are. Rough per-student egress for a slides lesson with the teacher
camera: **~0.9 Mbps standard, ~0.4 Mbps low** (audio and whiteboard are tiny;
see [BANDWIDTH.md](BANDWIDTH.md)). With `EGRESS_MBPS` the script prints how many
students fit at each profile (80 % of the uplink usable). If even `low` does
not fit, add a media node ([MULTI-SERVER.md](MULTI-SERVER.md)) or ask students
to pick "Audio + share only".

## 3. What else keeps a small box steady

- **No per-student server storms.** Sample rotation, admits, leaves, mic
  requests and the video panel nudge only the students they affect; students
  receive a trimmed `/state` (teacher, on-screen students, themselves) rather
  than the class roster. Permission pushes (mute all, teacher reconnect) are
  one batch with bounded concurrency (`PERMISSION_PUSH_CONCURRENCY`, 8), never
  a room listing per student.
- **Cheap polls.** The student "is my class open?" poll reuses the expanded
  timetable per worker (`STUDENT_SCHEDULE_CACHE_MS`, 10 s).
- **Bounded reports.** Attendance reports read sessions a page at a time and
  yield between pages, so a year-long CSV does not stall live classes.
- **Postgres** runs with small buffers, no parallel query workers and SSD cost
  settings; connections = workers × pool + headroom.
- **Redis** is AOF-only (no RDB fork that doubles memory) with `volatile-ttl`
  eviction: only expiring keys can be evicted, never the attendance queue.
- **Logs** rotate (`LOG_MAX_SIZE` × `LOG_MAX_FILES` per container).
- **Housekeeping** deletes old student participant rows
  (`PARTICIPANT_RETENTION_DAYS`, 30).
- **Graceful restarts.** `docker compose restart web` drains requests for
  `WEB_SHUTDOWN_GRACE_MS` (10 s) and exits; attendance events are already in
  Redis, so nothing is lost.

## 4. Check it

```bash
docker stats --no-stream                 # memory per container vs. its limit
curl -s http://127.0.0.1:3000/api/health # from the host: status, worker, pool
docker compose logs --tail 50 web        # "[classroom] per-worker memory: …"
```

Watch the uplink during a real class (`ifstat`, `nload`, or the cloud
console). If it sits near the line rate, switch to `MEDIA_PROFILE=low` (no
rebuild: `docker compose up -d web`, then students reload) before adding
hardware.

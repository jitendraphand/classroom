# Class capacity (2,500 concurrent students)

The web app does not cap how many students can be in a class, and it does not cap how many classes can run at once. A student sees "This class is full." only when an administrator has set a positive **Students per class** value under Settings → Class size and microphones. The default is empty (no limit). The same page can limit how many student microphones are open at once; `0` means no microphone cap.

The rotating camera sample (at most six student cameras in the teacher's mosaic) is a bandwidth choice. It is not a class-size limit. Students who are not in the mosaic still attend, hear the class, and can be heard when the teacher unmutes them.

Target for this generation: **2,500 concurrent students** on one large server (one class or many, even or uneven), using all cores. The 2026-10-21 load test (185 browsers + ~410 total connections) showed the ceiling was a **single Next.js process** and a **Prisma pool larger than Postgres `max_connections`**, not host CPU.

## What actually limits a server

| Component | Per-student cost at 2,500 | Expected limit on one large box (32 OCPU / 64 GB, ~1–2 Gbps NIC) |
|---|---|---|
| **Web (Next.js cluster)** | ~1 HTTP keepalive while in class; no SSE while LiveKit is up; safety poll every 60 s | CPU: 16 workers × one core. Was 1 process at 2.2 cores / 500 connections. **2,500 HTTP idle sockets + rare polls should fit.** Unproven at 2,500. |
| **SSE / chat stream** | 0 while LiveKit is connected (fallback only) | Previously 1 Redis subscriber + 1 HTTP stream per student — that path is what 502'd at ~500. |
| **Redis** | ~1–3 KB room hashes (heartbeat, mute, hands) + pub/sub for fallback SSE | Memory: a few tens of MB. Default `REDIS_MAXMEMORY=256mb`; `scripts/configure-resources.sh` sets 96–128 MB on small boxes and 1 GB on large ones. |
| **Postgres** | Token/join writes at arrival; chat persist; `/state` on join and 60 s safety | Connections: `WEB_WORKERS × DB_POOL_PER_WORKER`. Auto: every CPU on ≤ 8-CPU boxes, else `WEB_CPU_FRACTION` (0.5) of the CPUs; the pool per worker is the share of `POSTGRES_MAX_CONNECTIONS` (compose default 100; `configure-resources.sh` writes 400 on large boxes; minus 24 headroom) clamped to 3–10. So 64 vCPU at 400 gets 32 × 10 = 320. See docs/SCALING.md. |
| **LiveKit CPU** | Mix of audio + teacher camera + optional share. Whiteboard is data-only. | Load test: 4.1 cores at ~410. Linear guess ~25 cores at 2,500 — **tight on 32 OCPU if everyone gets video share.** Whiteboard-only is much cheaper. |
| **LiveKit bandwidth** | ~0.15 Mbps whiteboard lesson; ~0.6 Mbps slides+camera (see [BANDWIDTH.md](BANDWIDTH.md)); ~1.1–1.6 Mbps video-share | 2,500 × 0.6 Mbps = **1.5 Gbps egress**. The 32 OCPU test peaked at 380 Mbps / 410. **Egress is the likely hard limit** unless the lesson is whiteboard/audio. |
| **LiveKit UDP ports** | 1–2 ports per participant with `port_range 50000–60000` (~10k ports) | 2,500 × 2 = 5,000 < 10,000. Alternative: `rtc.udp_port` single-port mux (see `infra/livekit.example.yaml`). |
| **File descriptors** | 1 LiveKit WS + 1 HTTP keepalive per student, plus workers × (Postgres + Redis) | Compose sets `ulimits.nofile` 1048576 on web/livekit/caddy/redis/postgres. Host `fs.file-max` must allow it. |

Since 2026-10-24 the web cluster takes only half the CPUs on big boxes (docs/SCALING.md); previously LiveKit and the web workers shared all cores. LiveKit gets priority when the CPU is contended: compose gives it `cpu_shares: 8192` against the web container's `512`, and the web workers also run at `nice` `WEB_NICE` (default 5). Idle cores are never left unused. There are no software caps on per-class or per-room counts, total participants, or join rate (`JOIN_RATE_LIMIT_PER_MINUTE` is off by default). The only optional cap is the school's own *max students per class* setting, which is empty (unlimited) by default.

`room.max_participants` is **0** (unlimited) in `infra/livekit.example.yaml`. The process does not reject a join before ports, CPU or egress run out.

When one machine is not enough for **media**, add LiveKit nodes the way [MULTI-SERVER.md](MULTI-SERVER.md) already describes. Each extra node brings its own UDP range and NIC. Do not raise a single node's port range past what the firewall allows.

Open the matching firewall range (see [DEPLOY-VPS.md](DEPLOY-VPS.md) and [DEPLOY-CADDY.md](DEPLOY-CADDY.md)):

```bash
sudo ufw allow 50000:60000/udp
# or, if using single-port mux: sudo ufw allow 7882/udp
```

## Sizing env (one box)

| Env | Default | 2 GB VPS | 32 OCPU / 64 GB aiming at 2,500 |
|---|---|---|---|
| `WEB_WORKERS` | all CPUs ≤ 8, else CPUs × `WEB_CPU_FRACTION` (0.5), capped to fit Postgres | `1` or `2` | `16` |
| `DB_POOL_PER_WORKER` | `10` | `8` | `8` (16×8=128) |
| `POSTGRES_MAX_CONNECTIONS` | `100` | `~30` (script) | `200` |
| `POSTGRES_SHARED_BUFFERS` | `256MB` | `256MB` | `8GB` |
| `POSTGRES_EFFECTIVE_CACHE_SIZE` | `1536MB` | `1536MB` | `48GB` |
| `REDIS_MAXMEMORY` | `256mb` | `96mb` (script) | `1gb` |

Prisma `connection_limit` and `pool_timeout` are appended in `lib/db.ts` when missing from `DATABASE_URL`.

**PgBouncer:** optional, off by default. Prisma can talk to PgBouncer in transaction mode with `pgbouncer=true` on the URL, but this repo uses interactive `$transaction` (attendance, teacher create, ranking). Do not put PgBouncer in front until those are audited. Prefer `DB_POOL_PER_WORKER` × workers below `max_connections`.

## Math for 2,500 on one large server

- **Web sockets:** 2,500 × ~2 FDs = 5,000, plus 16 workers × (8 Postgres + a few Redis, including SSE fallback duplicates). Well under 1,048,576.
- **Postgres:** 16 × 8 = 128 < 200. Chat is the write hot path (human-typed, not 2,500/s).
- **Redis:** heartbeat every 30–35 s × 2,500 ≈ 80 HSETs/s. Trivial.
- **LiveKit ports:** 5,000 of 10,000.
- **Egress:** whiteboard class ≈ 0.15 Mbps × 2,500 = **375 Mbps** (plausible). Slides+camera ≈ **1.5 Gbps** (needs a bigger NIC or more media nodes). Video-share ≈ 3 Gbps (plan extra media nodes).
- **CPU:** unknown at 2,500. Host was 24% at 410 with one web process saturating. Cluster + data-channel fan-out is the bet; **unproven**.

## What is unproven

- 2,500 participants in **one** LiveKit room (SFU subscription graph, data-channel fan-out of whiteboard strokes).
- Mute-all permission storm (`updateParticipant` × N) even though the **signal** is one data packet.
- Egress above ~400 Mbps on the class of host used in the 2026-10-21 test.
- Caddy → clustered Node keepalives at 2,500 concurrent HTTP/2 streams.
- Late joiners fetching a large whiteboard snapshot + chat history at once.

Reproduce with `scripts/loadtest/` (credentials from env only; see that README).

## Client rules that keep the 2,500 path cheap

- Students subscribe to **teacher tracks + classmate audio + the spotlight camera**. Never student-to-student video (`StudentMediaPrivacy`, `autoSubscribe: false`).
- `adaptiveStream` + `dynacast` on.
- Heartbeats every **≥30 s**, jittered.
- High-frequency events (whiteboard ops, draw pts, chat, hand, draw-request) reach viewers over **LiveKit data channels**. Only the teacher publishes data directly; a student's strokes, ops, messages and hands go through the API, which checks the permission and relays them as server packets (students hold no data grant).
- Permission pushes (mute all, teacher reconnect, sample rotation) are one batch per event with bounded concurrency (`PERMISSION_PUSH_CONCURRENCY`), and use the `updateParticipant` result instead of listing the room per student.
- An empty `canPublishSources` means "everything" to LiveKit, so a student who may publish nothing gets `canPublish: false`.
- Mute-all is still **server-side** (LiveKit `updateParticipant` / `mutePublishedTrack`). Clients only receive the signal.

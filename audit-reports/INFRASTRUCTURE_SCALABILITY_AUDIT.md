# Infrastructure, Scalability and Cost Audit

## Current deployment (verified)
- One Linux VM, `docker compose` with **host networking**: postgres:16, redis:7 (AOF everysec, volatile-ttl, loopback), livekit-server v1.13.9, web (Next.js cluster), optional Caddy (TLS, HSTS, compression, SSE-safe).
- Optional extra LiveKit media nodes (`docker-compose.media.yml`, `lib/mediaServers.ts`, `docs/MULTI-SERVER.md`): rooms are assigned to nodes.
- `scripts/configure-resources.sh` sizes memory limits, Postgres buffers, Redis maxmemory, worker count and `MEDIA_PROFILE` from the host's CPU, RAM and `EGRESS_MBPS`. CI dry-runs it for 2/4/8/64 GB.
- Health checks on every service; log rotation at 10 MB × 3.

## Single points of failure
| Component | SPOF? | Consequence | Mitigation |
|---|---|---|---|
| The VM | Yes | Everything down | Accept for a school; keep a tested rebuild runbook plus backups |
| Postgres | Yes, **no backups** | Data loss (attendance) | INF-01 |
| Redis | Yes (AOF persisted) | Live state lost on loss; recoverable | OK |
| LiveKit | Yes (unless multi-node) | Live classes drop | Multi-node exists |
| TLS certificates for TURN | Manual LiveKit restart on renewal (compose comment) | TURN breaks after ~60 days if enabled and forgotten | Automate the restart with a Caddy event hook or cron |

## Capacity model (estimates; egress dominates)
Logged-in but idle users cost almost nothing (≈3.5 req/min each while in class; dashboards poll every 30 s). Classroom concurrency drives cost.

| Concurrent students in class | SFU egress (slides + cam, ~0.6 Mbps) | LiveKit CPU (~1 core/100, repo ratio) | Web req/s (~3.5/min each) | Suggested footprint |
|---|---|---|---|---|
| 100 | ~60 Mbps | ~1 core | ~6 | 2 vCPU / 4 GB, `MEDIA_PROFILE=standard` |
| 500 | ~300 Mbps | ~5 cores | ~30 | 8 vCPU / 16 GB on a ≥500 Mbps NIC, or 2 media nodes |
| 1,000 | ~600 Mbps | ~10 cores | ~60 | 16 vCPU + 1 Gbps, or 3–4 × 200 Mbps media nodes |
| 5,000 | ~3 Gbps | ~50 cores | ~290 | Web/DB box + 15+ media nodes (≈200 students per 200 Mbps node, per docs) |
| 10,000 | ~6 Gbps | ~100 cores | ~580 | As above ×2; Postgres on its own host; consider a pooler (PgBouncer) |

Join ramps cost several times the steady CPU (LiveKit 16–22 cores during a 1,500-student ramp, per `docs/SCALING.md`); join pacing already spreads them.

## Cost levers (ordered)
1. **Egress per student** (DATA-01, DATA-02, `MEDIA_PROFILE=low` on small boxes). Egress is usually the dominant cost on clouds that bill it, and the capacity limit everywhere.
2. Prefer hosts with included egress (many VPS plans) over per-GB clouds for media nodes.
3. Do not add a CDN for media (an SFU is not CDN-cacheable). A CDN for `/_next/static` is cheap but unnecessary at school scale: assets are immutable and cached per device.

## Observability gaps
INF-02: no metrics or alerting. Minimal stack: LiveKit `prometheus_port`, node-exporter, and a 100-MB VictoriaMetrics single node with 4 alerts (egress > 80% NIC, LiveKit CPU > 80%, web 5xx > 1%, Postgres disk > 80%).

## Backup and disaster recovery
INF-01: none. Proposed: nightly `pg_dump -Fc` → off-box object storage (14 daily, 8 weekly); weekly restore test into a scratch container; RPO 24 h, RTO < 2 h, documented in `docs/DEPLOY-VPS.md`.

## Over- and under-provisioning
- Postgres `max_connections=100` and `ulimit nofile=1M` for every container are generous but harmless.
- Redis `maxmemory 256mb` default: fine (the docs measure "a few tens of MB").
- Under: no TURN (REL-01); no backup storage.

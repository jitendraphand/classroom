# Multi-server media (N LiveKit nodes, one web server)

Status: shipped 2026-10-16. Default is unchanged: with no `LIVEKIT_SERVERS`
set there is exactly one media node (the LiveKit next to the web app), and no
extra Redis lookup happens on any request.

## Why
Every measured VM so far has a hard **~200 Mbps egress cap** (E2E C3.8GB and
SDC3-4.30GB: 196-200 Mbps; C3.32GB ~270 Mbps). CPU is not the limit (15% of 16
vCPU at 500 students). A class costs egress per student, so capacity grows only
by adding media nodes. See docs/BANDWIDTH.md for the per-student bitrate.

## How it works
- `apps/web/src/lib/mediaServers.ts` holds the registry.
- The first token for a class session (LiveKit room `classroom_<code>_<session>`)
  assigns the room to the **least-loaded node** = lowest `students / capacity`
  (ties: fewer students, then list order). The assignment is stored in Redis
  (`media:room:<room>`, `SET NX`, 12 h) and is **sticky for the session**:
  every later token, the screen-share sidecar token, the admin preview token,
  and every server call (mute, remove, send data, list participants, delete
  room) go to the same node.
- Load = students per room, refreshed on each student token
  (`media:load:<node>` hash). Ending the class releases it.
- Tokens are signed with that node's key and the browser gets that node's
  `url`. Webhooks from any registered node are accepted (each node's key is
  tried).
- Draining: `POST /api/admin/media-servers {"draining":["m2"]}` stops new
  classes going to m2 (running classes stay until they end). `GET` shows each
  node's load.

## Configure (web server `.env`)
```
LIVEKIT_SERVERS=[{"id":"m1","url":"wss://161-118-183-33.sslip.io","httpUrl":"http://127.0.0.1:7880","capacity":200},
                 {"id":"m2","url":"wss://media2.example.com","httpUrl":"https://media2.example.com","apiKey":"APIm2...","apiSecret":"...","capacity":200}]
```
- `url`: what browsers connect to (wss). Omit on the local node to keep the
  request-derived URL.
- `httpUrl`: LiveKit server API (the web server must reach it; https through the
  node's Caddy works).
- `apiKey`/`apiSecret`: default to `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`.
- `capacity`: students with good quality on that node (see below).
Restart `web` after changing it. Keep secrets only in `.env` (never commit).

## Add a media node
1. New VM (Ubuntu 24.04, Docker). Open UDP 50000-60000, TCP 7881, TCP 443/80,
   and TURN ports if used.
2. Clone the repo, `cp infra/livekit-media.example.yaml infra/livekit-media.yaml`,
   set keys + webhook URL, set `MEDIA_DOMAIN` in `.env`.
3. `docker compose -f docker-compose.media.yml --profile media up -d`
4. Add it to `LIVEKIT_SERVERS` on the web server, restart `web`.
5. `GET /api/admin/media-servers` should list it; start a test class and check
   it is assigned (Redis `media:room:*`).

## Capacity planning
- **~200 students per C3.8GB-class node** (200 Mbps egress / ~0.6-0.9 Mbps per
  student after the 2026-10-16 bandwidth work; ~300 was the run-4 ceiling at
  270 Mbps with the old bitrates). Use `capacity: 200` unless a load test shows
  otherwise.
- The web/DB server stays single; at 1000 students it needs ~2-4 vCPU (run 4:
  web + Postgres + Redis were a small part of 16 vCPU).
- Oracle Always Free: this deploy keeps one node (N=1). Adding nodes there means
  new OCI resources, which this change does not do.

# Multi-server: how every feature behaves (round 6)

Topology: **one** web + Postgres + Redis server (Next.js, Caddy) and **N**
LiveKit media nodes (`LIVEKIT_SERVERS`, see `MULTI-SERVER.md`). Unset
`LIVEKIT_SERVERS` = today's single-node deploy, no extra Redis lookups.
Everything below was checked against the code (`lib/mediaServers.ts`,
`lib/livekit.ts`, `lib/whiteboardServer.ts`, `lib/redis.ts`).

| Feature | Where the state lives | Multi-node behaviour | Status |
|---|---|---|---|
| Room affinity | Redis `media:room:<livekitRoom>` (12 h) | A class's LiveKit room is placed on ONE node for the whole session (least loaded by students/capacity). Every token (student, teacher, screen sidecar, admin) is signed with that node's key and carries that node's URL (`mediaUrlForRoom`). | Done |
| Admin previews / observe across nodes | none (token per request) | `/api/admin/live/[code]/token` uses `createObserverToken` → `signerFor(room)` + `mediaUrlForRoom(room)`; the admin's browser connects straight to the room's node. Several previews on different nodes = several connections, each to its own node. | Done (verified in code; covered by `mediaServers` tests) |
| Teacher device switch / rejoin | Redis (teacher presence, takeovers), Postgres (session) | Same session id → same LiveKit room name → same node (sticky key). Reopening a class rotates the session id, so the NEW room is placed afresh (may move to a less-loaded node; nobody is in the old one). | Done |
| Node failure (failover) | — | Media is not replicated (SFU state is per node). If a node dies its rooms drop; clients reconnect, the token route sees the node is draining/unhealthy only if an admin drains it. **Gap (not cheap):** automatic health checks + re-placement of the room key. Manual: drain the node in Admin → Media servers, students rejoin and land on a healthy node once the class is reopened. | Documented |
| Whiteboard state / snapshots | Teacher device (source of truth) **+ Redis `room:<code>:wbsnap`** | New in round 6: the teacher (web + Windows) stores the latest snapshot on the server every ≤5 s while the board changes; a student whose snapshot request the teacher's device does not answer (teacher reconnecting, moving device) gets the stored copy via `/whiteboard {action:'stored'}`. Ops relay goes through `roomServiceFor(room)` → the right node. | Fixed (cheap gap) |
| Chat, hand raise, draw requests, annotations | Postgres (chat) / Redis keys `room:<code>:*` | Written by the single web server, pushed to the room via `roomServiceFor(room).sendData` (node-aware). No per-node state. | Done |
| Shared Redis pub/sub | single Redis on the web server | All web instances (if ever more than one) share Redis; LiveKit nodes do not need Redis for classroom state. LiveKit's own multi-node Redis is NOT used: rooms never span nodes. | Done |
| DeepFilterNet agent | — | Design: one worker per media node (Compose service next to LiveKit, joins only rooms on its node with that node's key). **Not shipped in round 6** (see `eval/` and report). | Not shipped |
| TURN | `infra/livekit.yaml` per node | Each node runs its own embedded TURN (UDP 3478 / TLS 5349) with its own domain/cert; clients get TURN from the node they connect to. Keep each node's `livekit.yaml` untracked like on the current server. | Per-node config |
| Node health / load-based placement | Redis `media:load:<node>` (webhook participant counts) | Placement uses live student counts from LiveKit webhooks (`noteRoomLoad`). Drained nodes are skipped. **Gap:** no active health probe; a dead node with stale load can still be picked → add a probe (`ListRooms` with 2 s timeout) before placement. | Partly |
| Draining a node | Redis `media:servers:disabled` | Admin → Media servers → drain: no NEW rooms are placed there; running classes finish. | Done |
| Recording | — | No recording feature exists today. If added: run Egress on the same node as the room (Egress per node, node chosen by the room key). | n/a |
| Single web / DB server | Postgres + Redis on the web box | Single point of failure by design (OCI Always Free: one A1 VM). Backups are the operator's job. | By design |

## Local multi-node test
No Docker on the build box, so two LiveKit containers could not be started
here. Placement, draining and token/URL selection are covered by unit tests
(`tests/run4Fixes.test.ts`), and the admin-preview route goes through the
same `mediaUrlForRoom`/`signerFor` as the student token.

# Deploy on a VPS with a public IP (no domain)

Goal: serve the app at `http://PUBLIC_IP:3000` and LiveKit at `ws://PUBLIC_IP:7880` so teachers/students can join from the internet without a DNS name.

## Why host networking

This stack uses Docker **`network_mode: host`** on a **single Linux VM**. That is intentional for WebRTC:

- LiveKit binds UDP `50000–50100` and TCP `7880`/`7881` directly on the host NICs.
- Published-port bridge NAT often breaks UDP ICE on small VPS images; host mode avoids that.
- Postgres/Redis stay reachable on `127.0.0.1` inside the VM. **Do not open 5432/6379** on the cloud firewall.

If you later put a reverse proxy / TLS terminator on the same VM, keep LiveKit on host ports (or a dedicated host NIC) and only proxy the Next.js HTTP port.

## Prerequisites

- Ubuntu/Debian-style VM with Docker Engine + Compose plugin
- A public IPv4 (example below: `203.0.113.10`)
- Outbound UDP allowed (LiveKit may use STUN to discover the external IP)

## 1. Firewall

Open **inbound**:

| Port | Proto | Purpose |
|------|-------|---------|
| 3000 | TCP | Next.js web UI + API |
| 7880 | TCP | LiveKit signaling (WebSocket) |
| 7881 | TCP | LiveKit RTC over TCP fallback |
| 50000–50100 | UDP | LiveKit WebRTC media |

Keep closed to the public internet: **5432** (Postgres), **6379** (Redis), **22** only from your admin IPs.

Example (ufw):

```bash
sudo ufw allow 3000/tcp
sudo ufw allow 7880/tcp
sudo ufw allow 7881/tcp
sudo ufw allow 50000:50100/udp
sudo ufw enable
sudo ufw status
```

Cloud security groups (AWS/GCP/Azure): mirror the same rules.

## 2. Clone and configure

```bash
git clone https://github.com/jitendraphand/classroom.git
cd classroom

cp -n .env.example .env

# Replace with your real public IP
PUBLIC_IP=203.0.113.10 ./scripts/configure-public-ip.sh
```

That sets:

- `APP_URL` / `NEXT_PUBLIC_APP_URL` → `http://PUBLIC_IP:3000`
- `NEXT_PUBLIC_LIVEKIT_URL` → `ws://PUBLIC_IP:7880`
- `LIVEKIT_USE_EXTERNAL_IP=true`
- `LIVEKIT_NODE_IP=PUBLIC_IP` (pins ICE advertise address)
- `COOKIE_SECURE=false` (required for HTTP on a bare IP)
- Server-side `LIVEKIT_*` / DB / Redis remain on `127.0.0.1`

Rotate secrets in `.env` before production:

- `LIVEKIT_API_SECRET` — long random hex
- `NEXTAUTH_SECRET` — long random hex
- `POSTGRES_PASSWORD` — and matching `DATABASE_URL`

Then sync LiveKit config and start:

```bash
./scripts/sync-livekit-keys.sh
docker compose up --build -d
```

## 3. Verify

From your laptop (not only on the VM):

```bash
curl -s http://PUBLIC_IP:3000/api/health
# expect: "status":"healthy"

# LiveKit HTTP health (signaling port)
curl -sI http://PUBLIC_IP:7880 | head -1
```

Browser:

1. Open `http://PUBLIC_IP:3000/register` → create teacher
2. Create a room → join link should be `http://PUBLIC_IP:3000/join/CODE` (not localhost)
3. Second browser/device on another network → open that join link
4. Admit student → video/audio should connect (LiveKit URL in network tab: `ws://PUBLIC_IP:7880`)

## 4. How URLs are resolved

| Concern | Behavior |
|---------|----------|
| Share / create-room join links | Prefer request `Origin` / `Host` when non-loopback; else `APP_URL` |
| Teacher lobby “Copy link” | Uses `window.location.origin` in the browser |
| LiveKit URL in tokens | Prefer non-loopback `NEXT_PUBLIC_LIVEKIT_URL`; else derive `ws(s)://<request-host>:7880` |
| Auth cookies | `Secure` only when `COOKIE_SECURE=true` or `APP_URL` is `https://` — **HTTP public IP → Secure=false, SameSite=Lax** |

Always set env to the public IP so rebuilds and server-side defaults stay correct even without a Host header (health checks, scripts).

## 5. TLS / WSS later (optional)

Browsers allow `ws://` on `http://` IP pages. **Let's Encrypt needs a domain** (A/AAAA → this VM); it will not issue certificates for a bare public IP.

For production HTTPS/WSS with **Caddy + Let's Encrypt**, see **[DEPLOY-CADDY.md](DEPLOY-CADDY.md)**:

```bash
DOMAIN=class.example.com PUBLIC_IP=203.0.113.10 ACME_EMAIL=admin@example.com \
  ./scripts/configure-domain-tls.sh
./scripts/sync-livekit-keys.sh
docker compose --profile tls up --build -d
```

That proxies Next.js and LiveKit **signaling** (WSS) through Caddy; WebRTC media UDP/TCP stays direct to LiveKit. Camera permissions and Secure cookies work reliably on HTTPS.

Without a trusted cert, getUserMedia / Secure cookies may still be limited on some browsers.

## 6. TURN (optional, restrictive NATs)

If some students connect to signaling but never get media, add a TURN server and point LiveKit `rtc` / client iceServers at it. Not required for typical home/office NATs when `use_external_ip` / `node_ip` are set and UDP `50000–50100` is open.

## 7. Stop / wipe

```bash
docker compose down
# wipe DB/redis volumes:
docker compose down -v
```

## Checklist

- [ ] `PUBLIC_IP` set via `configure-public-ip.sh`
- [ ] Firewall: 3000/tcp, 7880/tcp, 7881/tcp, 50000–50100/udp
- [ ] 5432/6379 **not** public
- [ ] `./scripts/sync-livekit-keys.sh` after every LiveKit secret or IP change
- [ ] `infra/livekit.yaml` shows `use_external_ip: true` (and `node_ip` if set)
- [ ] External `curl http://PUBLIC_IP:3000/api/health` healthy
- [ ] Join links show the public IP, not localhost

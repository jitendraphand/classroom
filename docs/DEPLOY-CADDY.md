# Deploy with Caddy + Let's Encrypt (HTTPS / WSS)

Goal: serve the app at `https://DOMAIN` and LiveKit signaling at `wss://livekit.DOMAIN`, with automatic TLS from Let's Encrypt via Caddy.

> **Hostname required (not a bare IP in the browser URL).** Let's Encrypt will not issue certificates for `https://1.2.3.4`. You need a DNS name that points at the VM.
>
> Options:
> - **Your own domain** — A records you control (sections below).
> - **Free IP hostname** — [sslip.io](https://sslip.io) / [nip.io](https://nip.io) map a name to your IP (e.g. `https://81-223-254-76.sslip.io`). Use `scripts/configure-sslip-tls.sh` (see § sslip.io below).
> - **HTTP only, no TLS** — [DEPLOY-VPS.md](DEPLOY-VPS.md) + `configure-public-ip.sh`.

## What Caddy proxies (and what it does not)

| Traffic | Path |
|---------|------|
| Next.js HTTP UI + API | Caddy `:443` → `127.0.0.1:3000` |
| LiveKit **signaling** (WebSocket) | Caddy `livekit.DOMAIN:443` → `127.0.0.1:7880` |
| LiveKit **media** (WebRTC UDP + TCP RTC) | **Direct to LiveKit** on the host — **not** through Caddy |

Caddy cannot terminate WebRTC UDP. Keep UDP `50000–50100` and TCP `7881` open to the public internet (same as the bare-IP deploy). `LIVEKIT_NODE_IP` / `use_external_ip` still advertise the VM public IP for ICE.

All Compose services (including Caddy) use **`network_mode: host`** so Caddy can reach loopback Next.js/LiveKit and bind `:80`/`:443` on the VM.

## Prerequisites

- Ubuntu/Debian-style VM with Docker Engine + Compose plugin
- A domain you control (example: `class.example.com`)
- Public IPv4 (and optionally IPv6)
- DNS ready **before** first Caddy start (LE HTTP-01 needs `DOMAIN` reachable on port 80)


## sslip.io / nip.io (no custom domain)

Services like **sslip.io** publish DNS for names derived from your public IP. Caddy treats them like any other hostname and can get a Let's Encrypt cert.

| Public IP | App URL | LiveKit WSS |
|-----------|---------|-------------|
| `81.223.254.76` | `https://81-223-254-76.sslip.io` | `wss://livekit.81-223-254-76.sslip.io` |

Subdomains such as `livekit.81-223-254-76.sslip.io` also resolve to that same IP (sslip.io behavior), so the existing Caddyfile layout works unchanged.

```bash
cp -n .env.example .env

PUBLIC_IP=81.223.254.76 ACME_EMAIL=admin@example.com \
  ./scripts/configure-sslip-tls.sh

# Optional: nip.io instead
# SSLIP_BASE=nip.io PUBLIC_IP=81.223.254.76 ./scripts/configure-sslip-tls.sh

./scripts/sync-livekit-keys.sh
docker compose --profile tls up --build -d
```

No registrar or manual A records. Still open firewall **80/443**, **7881**, and UDP **50000–50100** as in §2. Confirm resolution first:

```bash
getent ahostsv4 81-223-254-76.sslip.io
# expect your PUBLIC_IP
```

**Caveats:** you depend on sslip.io/nip.io availability and their rate limits; for production teaching, prefer a domain you control. Some corporate filters block `*.sslip.io`.

## 1. DNS

Create **A** (and/or **AAAA**) records:

| Name | Type | Value |
|------|------|-------|
| `class.example.com` | A | `PUBLIC_IP` |
| `livekit.class.example.com` | A | `PUBLIC_IP` |

Wait until both resolve (`dig +short class.example.com`) before bringing Caddy up.

## 2. Firewall

| Port | Proto | Purpose |
|------|-------|---------|
| **80** | TCP | ACME HTTP-01 + HTTP→HTTPS redirect |
| **443** | TCP | HTTPS (app) + WSS (LiveKit signaling via subdomain) |
| **7881** | TCP | LiveKit RTC over TCP fallback (**direct**, not via Caddy) |
| **50000–50100** | UDP | LiveKit WebRTC media (**direct**) |

**Do not** expose publicly when using Caddy:

- **3000** — Next.js (only Caddy should reach it on loopback; block at cloud firewall / ufw)
- **7880** — LiveKit signaling (browsers use `wss://livekit.DOMAIN` through Caddy)
- **5432**, **6379** — Postgres / Redis

Example (ufw):

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 7881/tcp
sudo ufw allow 50000:50100/udp
# If you previously opened these for bare-IP HTTP, close them:
sudo ufw delete allow 3000/tcp || true
sudo ufw delete allow 7880/tcp || true
sudo ufw enable
sudo ufw status
```

> **Note:** The `web` service still listens on `0.0.0.0:3000` (host networking). Binding it to localhost-only when the `tls` profile is active is not wired in Compose; rely on the cloud/host firewall to keep 3000/7880 off the public internet.

## 3. Configure and start

```bash
git clone https://github.com/jitendraphand/classroom.git
cd classroom

cp -n .env.example .env

# Required: DOMAIN + PUBLIC_IP. Optional: ACME_EMAIL for Let's Encrypt account notices.
DOMAIN=class.example.com PUBLIC_IP=203.0.113.10 ACME_EMAIL=admin@example.com \
  ./scripts/configure-domain-tls.sh

./scripts/sync-livekit-keys.sh

# Profile `tls` starts the optional caddy service (plain `docker compose up` does not).
docker compose --profile tls up --build -d
```

That sets:

- `APP_URL` / `NEXT_PUBLIC_APP_URL` → `https://DOMAIN` (no `:3000`)
- `NEXT_PUBLIC_LIVEKIT_URL` → `wss://livekit.DOMAIN`
- `COOKIE_SECURE=true`
- `LIVEKIT_USE_EXTERNAL_IP=true` + `LIVEKIT_NODE_IP=PUBLIC_IP` (ICE still needs the public IP)
- Writes `infra/Caddyfile` with `DOMAIN` and `livekit.DOMAIN` reverse proxies
- Optional `email …` global option when `ACME_EMAIL` is set

Secrets in `.env` (`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`, `NEXTAUTH_SECRET`, `POSTGRES_PASSWORD`) are generated by the script when missing, placeholders or known-leaked; `infra/livekit.yaml` is generated and gitignored. Existing servers: see `docs/DEPLOY-VPS.md` → "Upgrading an existing server".

## 4. Compose profile

| Command | Caddy? |
|---------|--------|
| `docker compose up -d` | No — same as bare IP / local demo |
| `docker compose --profile tls up -d` | Yes — starts `caddy` (+ other services) |

Caddy image: `caddy:2-alpine`. Volumes: `infra/Caddyfile`, named volumes `caddy_data` (certs) and `caddy_config`.

## 5. Caddyfile shape

```caddyfile
{
	email admin@example.com   # optional; from ACME_EMAIL
}

class.example.com {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}

livekit.class.example.com {
	encode gzip
	reverse_proxy 127.0.0.1:7880
}
```

WebSocket upgrades for LiveKit are handled by Caddy by default (no extra `header_up` required).

To use a different LiveKit hostname, set `LIVEKIT_HOST=lk.example.com` when running `configure-domain-tls.sh` (must still have DNS → `PUBLIC_IP`).

## 6. Verify

```bash
curl -sI https://DOMAIN/api/health
# expect HTTP/2 200 and "status":"healthy" on GET

curl -sI https://livekit.DOMAIN/
# LiveKit responds on the proxied signaling port
```

Browser:

1. Create the school admin (`ADMIN_EMAIL` in `.env`, then `./scripts/create-admin.sh`; see DEPLOY-VPS.md → "School admin bootstrap"), sign in at `https://DOMAIN/login` and add a teacher  
2. Sign in as the teacher and start a class → join link should be `https://DOMAIN/join/CODE`  
3. Student joins → LiveKit URL in network tab: `wss://livekit.DOMAIN`  
4. Camera/mic prompts behave better on HTTPS than on bare HTTP IP  

Check Caddy / certs:

```bash
docker compose --profile tls logs caddy --tail 100
```

## 7. Switching from bare-IP HTTP

1. Point DNS at the VM and wait for propagation.  
2. Run `configure-domain-tls.sh` (overwrites the public-IP URL vars).  
3. `./scripts/sync-livekit-keys.sh`  
4. `docker compose --profile tls up --build -d`  
5. Tighten firewall (close 3000/7880 publicly; open 80/443).  

To go back to bare IP: run `configure-public-ip.sh`, stop the tls profile (`docker compose --profile tls down` then `docker compose up -d`), and reopen 3000/7880.

## 8. TURN (optional)

Same as bare-IP: if some clients get signaling but no media, add TURN. HTTPS does not replace TURN for restrictive NATs.

## Checklist

- [ ] DNS A/AAAA for `DOMAIN` and `livekit.DOMAIN` → `PUBLIC_IP`
- [ ] `DOMAIN=… PUBLIC_IP=… ./scripts/configure-domain-tls.sh`
- [ ] Optional `ACME_EMAIL` for LE notices
- [ ] Firewall: 80, 443, 7881, UDP 50000–50100; **not** public 3000/7880/5432/6379
- [ ] `./scripts/sync-livekit-keys.sh`
- [ ] `docker compose --profile tls up --build -d`
- [ ] `https://DOMAIN/api/health` healthy; join links use `https://`
- [ ] Media still uses direct UDP/TCP to LiveKit (ICE candidate shows `PUBLIC_IP`)

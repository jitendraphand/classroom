# Performance Benchmarks

Every number below is labelled. **Nothing here is invented**: "Measured" rows come from commands run during this audit (2026-11-26, in an x86_64 Linux cloud container, Node 22.23.5, Chromium from the pre-installed Playwright).

## 1. Measured

### 1.1 Test suite and static checks (main @ d9aa9a0)
| Check | Result |
|---|---|
| `npm test` (unit) | **598 / 598 pass**, 0 fail, 10.8 s wall |
| `tsc --noEmit` | 0 errors |
| `eslint .` | 0 errors, 2 warnings (`sub-admins/[id]/route.ts:4` unused import; `ClassroomRoom.tsx:1212` missing hook dependency) |
| `npm audit --omit=dev` | 1 critical (next), 2 high (zod, source-map-js), see SEC-01/05/09 |
| `next build` | Success; 33 app routes, 85 API route files, middleware 35.1 kB |
| Integration tests | **Not run**: need Postgres (see §3) |

### 1.2 Production JS per route (`next build`, computed from `app-build-manifest.json`, gzip level 9)
| Route | Files | Raw | Gzip |
|---|---|---|---|
| `/` (home) | 6 | 351.3 KiB | 103.8 KiB |
| `/join-class` | 6 | 358.8 KiB | 106.6 KiB |
| `/student` | 6 | 365.8 KiB | 108.6 KiB |
| `/teacher/dashboard` | 7 | 398.3 KiB | 118.6 KiB |
| **`/classroom/[code]`** | 11 | **1,293.7 KiB** | **364.9 KiB** |
| `/admin/live/[code]` | 15 | 1,346.0 KiB | 383.1 KiB |
| CSS (main sheet) | 1 | 80 KiB | 13 KiB |
| Largest chunk (`144d3bae…`, livekit-client + protobuf) | — | 531 KiB | — |
| Second (`7356…`: noise-suppressor glue, whiteboard, pdf) | — | 341 KiB | 103 KiB |

### 1.3 Page load (Playwright + CDP; served by the project's own standalone build on loopback; cache disabled; 360×740 mobile viewport)
Profiles: *desktop_fast* (no throttling); *lowend_phone_4g* (CPU ×6, 150 ms RTT, 1.6/0.75 Mbps); *lowend_phone_3g* (CPU ×6, 400 ms RTT, 0.4/0.4 Mbps).

| Profile | Page | Transfer | Req | TTFB | FCP | LCP | CLS | DOM nodes | JS heap |
|---|---|---|---|---|---|---|---|---|---|
| desktop_fast | `/` | 221.1 KiB | 17 | 12 ms | 96 ms | 96 ms | 0 | 49 | 2.9 MB |
| desktop_fast | `/login` | 220.7 KiB | 16 | 4 ms | 60 ms | 60 ms | 0 | 55 | 3.2 MB |
| desktop_fast | `/join-class` | 221.0 KiB | 16 | 39 ms | 104 ms | 104 ms | 0 | 40 | 2.9 MB |
| lowend_phone_4g | `/` | 221.1 KiB | 17 | 152 ms | 888 ms | 888 ms | 0 | 49 | 2.9 MB |
| lowend_phone_4g | `/login` | 220.7 KiB | 16 | 153 ms | 928 ms | 928 ms | 0 | 55 | 3.2 MB |
| lowend_phone_4g | `/join-class` | 221.0 KiB | 16 | 152 ms | 836 ms | 836 ms | 0 | 40 | 3.0 MB |
| lowend_phone_3g | `/` | 221.1 KiB | 17 | 401 ms | 2,432 ms | 2,432 ms | 0 | 49 | 2.9 MB |
| lowend_phone_3g | `/login` | 220.7 KiB | 16 | 401 ms | 2,452 ms | 2,452 ms | 0 | 55 | 3.2 MB |
| lowend_phone_3g | `/join-class` | 221.0 KiB | 16 | 402 ms | 2,372 ms | 2,372 ms | 0 | 40 | 3.0 MB |

Caveats: `/join-class` on this server had no database, so its server-rendered data path errored or was empty. Its numbers reflect the shell only. Loopback has no real network variance. INP was not measured (no interaction script).

### 1.4 Caching (measured with curl and Playwright)
- `/_next/static/*`: `Cache-Control: public, max-age=31536000, immutable`, gzip.
- HTML: `no-store, must-revalidate` (intentional, so there is no stale chunk after a deploy).
- Cold `/login` → warm navigation to `/`: **221 KiB → 8 KiB** transferred.
- Largest cold items: framework chunk 54 KiB, woff2 font 48 KiB, chunk 46 KiB, woff2 font 32 KiB, CSS 14 KiB. **Fonts = 80 KiB (36%)**.

### 1.5 Cross-platform drift (measured by byte comparison)
- Windows `src/shared/web`: 29 files; 24 identical apart from the generated header; **5 differ** (audioPolicy 33 lines, voiceProcessor 26, voiceSettings 24, WhiteboardBoard 19, classFinish 12); 1 Windows-only (`icons.ts`).

### 1.6 Code size (measured with `wc -l`)
- `main` source files: 65,341 lines. Windows: 34,667 lines (including Cargo.lock). Android: 10,655 lines.

## 2. Reported by the repository (not re-measured; quoted with source)
| Claim | Source |
|---|---|
| LiveKit ≈4.1 cores at ≈410 connections; egress peak ≈380 Mbps on the test host | `docs/CAPACITY.md:17-18` (2026-10-21 test) |
| 1,500-student trial on 64 vCPU / 48 GB: 1,390 HTTP 503s (mostly `/state`) before tuning | `docs/SCALING.md:3` |
| Teacher camera measured ≈190 kbps at 360p15 | `videoQuality.ts:21` |
| Per-student egress estimate ≈0.35–0.55 Mbps (phone, slides) / 0.6–0.9 Mbps (laptop) | `docs/BANDWIDTH.md` (explicitly labelled estimates there too) |

## 3. Not measured: blocked, with the next step

| Wanted | Why blocked here | Next verification step |
|---|---|---|
| Full-stack runs (integration tests, `/state` latency, DB query times) | No Docker daemon; initialising a Postgres cluster as the `postgres` user was refused by this environment's permission policy | On a staging VM: `docker compose up`, then `npm run test:integration`; enable `pg_stat_statements` and capture the top-20 queries during a load test |
| Media bitrate, jitter, packet loss, connect/reconnect time | Running the downloaded official `livekit-server` binary was refused by the permission policy | Harness: LiveKit + 1 teacher page (fake camera and a canvas "share", the app's encodings) + N student pages; sample `getStats()` every 5 s; run under `tc qdisc netem` (1%/5% loss, 150/400 ms RTT); repeat with `scripts/loadtest` |
| Student device CPU/RAM/battery | No devices | Two reference devices (for example a 3 GB Android Go phone, a 4 GB Celeron laptop); Chrome `chrome://tracing` + Android `dumpsys batterystats` over a 30-min class |
| Android app startup/RAM | No emulator | `adb shell am start -W`, `dumpsys meminfo com.classroom.teacher` during class |
| Windows app startup/RAM/idle CPU | No Windows host | Task Manager / `Get-Process` every 5 s while idle, in class, and sharing; with and without the PERF-04 fix |

## 4. Estimates used elsewhere (derived from encoder caps in `videoQuality.ts`, not measured)
| Stream | Bitrate assumption | Per hour |
|---|---|---|
| Teacher mic (Opus speech, DTX) | 24–32 kbps while speaking | 10–15 MB |
| Classmates' mics | ~24 kbps while one speaks, ~0 otherwise (DTX) | 0–10 MB |
| Teacher camera (no share) | 190–300 kbps | 85–135 MB |
| Teacher camera, LOW layer while sharing | 60–90 kbps | 27–40 MB |
| Share, slides, phone (half-res layer) | 300–450 kbps | 135–200 MB |
| Share, slides, laptop (top layer, mostly static) | 500–1,500 kbps peak; much lower on static slides | 225–675 MB (upper bound) |
| Share, video mode | 1.0–1.5 Mbps | 450–675 MB |
| HTTP control traffic (state 1/min + heartbeat 1.5/min + chat 1/min, about 2–3 KiB each) | — | ~0.5 MB |

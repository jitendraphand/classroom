# Low-Resource Engineering Standard

Principle: **every budget starts from a baseline measurement.** Where this audit measured a baseline, it is shown. Where it could not, the budget is marked *provisional*: it must be confirmed by the first baseline run (PERFORMANCE_BENCHMARKS.md §3) and then frozen at baseline + a small allowance.

## 1. Web (student-facing routes)
| Metric | Baseline (measured 2026-11-26) | Budget | Enforcement |
|---|---|---|---|
| First-visit transfer, entry pages (`/`, `/join-class`, `/student`) | 221 KiB | ≤ 230 KiB now; ≤ 160 KiB after PERF-02 | CI: Playwright transfer check on the built app |
| Warm navigation transfer | 8 KiB | ≤ 15 KiB | same |
| Entry-route JS (gzip) | 104–109 KiB | ≤ 115 KiB | CI: script over `app-build-manifest.json` (as in PERFORMANCE_BENCHMARKS §1.2) |
| Classroom route JS (gzip) | 365 KiB | ≤ 370 KiB now; ≤ 300 KiB after PERF-01 | same; a PR fails on >5 KiB growth without a label |
| LCP on CPU ×6 + 1.6 Mbps/150 ms profile | 0.84–0.93 s | ≤ 1.5 s | CI Playwright vitals job |
| LCP on CPU ×6 + 0.4 Mbps/400 ms profile | 2.37–2.45 s | ≤ 3.0 s | same |
| CLS | 0 | ≤ 0.05 | same |
| Student polls while LiveKit is connected | state 60 s, chat 60 s, heartbeat 40 s+jitter | No new periodic request faster than 30 s without review | Unit test over `pollPolicy.ts` (exists) plus a lint rule flagging new `setInterval` < 1 s in `components/` |
| Video while the tab has been hidden >20 s | currently flowing | 0 kbps (after DATA-01) | Playwright media test |

## 2. Live classroom (per student, provisional until measured)
| Metric | Provisional budget | Rationale |
|---|---|---|
| Audio-only download | ≤ 40 kbps avg | Opus speech + DTX |
| Slides + small camera, phone | ≤ 0.55 Mbps avg | Current encoder caps |
| Slides + camera, laptop | ≤ 0.9 Mbps avg | Current caps |
| Video decodes per student | ≤ 2 | Current design; must never grow with class size |
| Connect time p95 (join after admit) | ≤ 5 s at 200 students | Join pacing |
| Reconnect after a 5 s outage, p95 | ≤ 8 s | LiveKit resume |
| Audio loss tolerance | intelligible at 5% loss | RED |

Enforcement: nightly media harness (LiveKit + N headless clients + netem) writes JSON; a job compares against budgets and fails on >10% regression.

## 3. Backend
| Metric | Provisional budget | Enforcement |
|---|---|---|
| `/state` p95 at 500 students | ≤ 150 ms | Load-test job (scripts/loadtest) |
| `/token` p95 | ≤ 300 ms | same |
| DB queries per student `/state` | ≤ 3 | Prisma query-count test (log events in integration tests) |
| Web RSS per worker | ≤ the recycle threshold (cluster.js) with zero recycles in a 1-h class | Logs/metrics |
| API JSON payload (student `/state`) | ≤ 4 KiB typical | Integration test asserting the size |
| Server egress per student | as §2 | LiveKit Prometheus |
| LiveKit CPU | ≤ 1 core / 100 participants steady state (repo-reported ratio) | Load test |

## 4. Android (teacher), provisional
| Metric | Budget | How |
|---|---|---|
| Cold start to sign-in | ≤ 1.5 s on the reference device | `am start -W` |
| RAM in class (PSS) | ≤ 250 MB | `dumpsys meminfo` |
| Battery, 60-min class with camera | ≤ 15% on the reference device | `batterystats` |
| Encoder layers with no subscriber | 0 (dynacast) | Profiler / SFU stats |

## 5. Windows (teacher), provisional
| Metric | Budget | How |
|---|---|---|
| Cold start | ≤ 4 s on a 4 GB / HDD laptop | Stopwatch script |
| Idle RAM (all processes) | ≤ 300 MB | `Get-Process` sum |
| Idle CPU (tray, no class) | ≤ 1% | Perf counters over 5 min |
| Sharing CPU (1080p slides, HW encode) | ≤ 25% on a quad-core i3 | same |
| Installer size | < 100 MB (current rule in `electron-builder.yml`) | CI artifact size check |

## 6. Release gate (every feature)
A PR that adds a feature must state, in its description:
1. **Bytes:** added student JS (gzip) and per-hour media/data impact.
2. **Periodic work:** any new timer, poll or subscription, and its rate when hidden.
3. **Server:** new queries per request, new Redis keys (TTL?), new background jobs (leader-locked?).
4. **Lifecycle:** what stops when the tab is hidden, the class ends, or the participant leaves.
5. **Weak network:** behaviour at 400 ms RTT / 5% loss / offline.

CI enforces items 1 and 2 automatically (bundle script, interval lint). Reviewers check 3–5.

## 7. Device and network test matrix (minimum)
| Tier | Device | Network |
|---|---|---|
| Low | Android Go phone, 2–3 GB RAM, Chrome | 3G profile (400 kbps / 400 ms) |
| Mid | 4 GB Android, Chrome | 4G (1.6 Mbps / 150 ms) + 1% loss |
| Laptop | 4 GB Celeron, Windows, Chrome/Edge | Wi-Fi with a 10-s drop |
| iOS | Oldest supported iPhone, Safari | 4G |

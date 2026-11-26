# Improvement Roadmap

Ordered by severity × impact ÷ effort. IDs refer to FINDINGS_REGISTER.md. Effort is one engineer.

## Immediate (this week)
| Item | IDs | Effort | Risk | Done when |
|---|---|---|---|---|
| Upgrade Next.js ≥15.5.29; `images.unoptimized: true` | SEC-01 | 1 h | Low | `npm audit` shows no critical/high in next |
| `SCHOOL_JOIN_MODE=signed` as the production default (boot warning or refusal when unsigned without an explicit opt-in); `/join-class` behind `ALLOW_NAME_JOIN`; default `JOIN_RATE_LIMIT_PER_MINUTE=60` | SEC-02, SEC-03 | 0.5–1 d | Medium (coordinate with the school's join flow) | Integration tests for refused paths |
| Caddy `request_body max_size`; per-route limits for hand, draw and feedback | SEC-04, SEC-05 | 0.5 d | Low | 413/429 tests |
| Nightly off-box `pg_dump` + restore drill | INF-01 | 0.5 d | Low | A restored copy boots |
| Android `RoomOptions(dynacast = true, adaptiveStream = true)` | PERF-03 | 1 h + device check | Low | Profiler shows lower encoder CPU with 0 subscribers to the high layer |

**Quick wins (high impact, low effort):** SEC-01, PERF-03, DATA-01, INF-01, CQ-02 (doc fixes), CQ-03.

## Short term (2–4 weeks)
| Item | IDs | Effort |
|---|---|---|
| Pause student video after 20 s hidden | DATA-01 | 0.5 d |
| Enable LiveKit TURN/TLS (443 on its own IP/hostname, or 5349); fix the Windows README | REL-01 | 1 d + DNS/firewall |
| Re-sync Windows shared modules → 1.2.1; trigger the Windows sync check on `main` pushes | REL-02 | 0.5–1 d |
| CI media smoke test (LiveKit + Postgres + Redis services, 3 headless clients, `bytesReceived` asserts) | TEST-01 | 2 d |
| Enable LiveKit Prometheus plus a tiny metrics store; alerts on egress, loss and 5xx | INF-02 | 1 d |
| Student network indicator plus "switch to audio" suggestion | UX-01 | 1 d |

## Medium term (1–3 months)
| Item | IDs | Effort |
|---|---|---|
| Audio-only and slide-snapshot modes; `saveData`/`effectiveType` start mode; data meter | DATA-02 | 2–3 d |
| Split teacher-only components out of the student bundle (`next/dynamic`); add a bundle budget check to CI | PERF-01 | 2 d |
| System font stack (or a single subset font) | PERF-02 | 0.5 d |
| Windows: scope no-throttle to the share session | PERF-04 | 1 d + measurement |
| Android contract fixtures shared with `main` tests | REL-03 | 2 d |
| Test VP9 fallback on old iOS / WebView; decide on VP8 for those subscribers | REL-04 | 1 d |
| Weak-network test pass (`tc netem`) in CI nightly | TEST-01 | 1 d |
| Chat purge 24 h after class end; `leftAt` partial index | SEC-07, PERF-08 | 0.5 d |

## Long term (3–12 months)
| Item | IDs | Notes |
|---|---|---|
| Replace the name form with roll-number + PIN, or finish school-app SSO | UX-02, SEC-02 | Product decision |
| Break up `ClassroomRoom.tsx` into StudentShell and TeacherShell; `main.ts`/`classSession.ts`/`MainActivity.kt` likewise | CQ-01 | Incremental, behind tests |
| Reduce three teacher clients to fewer code paths: keep Windows' byte-copy approach and extend it to more modules; consider a shared Kotlin-Multiplatform/TS-free protocol spec for Android | REL-02/03 | Lowers drift cost |
| Device lab: two reference low-end devices, a recorded 30-min class profile per release | Standard §5 | — |
| Only if a single class must exceed one media node's egress: evaluate an SFU-interactive + HLS-overflow hybrid | — | Not needed at current scale |

## Expected outcomes
- Security: no known critical/high advisories; student identity authenticated.
- Students: −50–90% data for disengaged or weak-link students (estimate, DATA-01/02); media for restricted networks (REL-01); ~15–30% less classroom JS (estimate, PERF-01).
- Server: egress falls with DATA-01/02 (egress is the cost driver).
- Reliability: drift caught in CI; media regressions caught before classes.

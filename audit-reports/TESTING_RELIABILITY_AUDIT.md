# Testing and Reliability Audit

## Current state
| Suite | Where | Count | Ran here? | Result |
|---|---|---|---|---|
| Web unit (`node --test`) | `apps/web/tests/*.test.ts` | 87 files, **598 tests** | Yes | **598 pass, 10.8 s** (measured) |
| Web integration (Postgres + Redis) | `apps/web/tests/integration/` | 4 files (admission, attendance, reports + helpers) | No: no database available | — |
| AI teacher | `apps/ai-teacher/tests` | — | No | CI runs it |
| Android JVM unit | `apps/android/app/src/test` | 10 files | No (no Gradle/SDK run) | — |
| Windows unit | `windows:tests/*.test.ts` | ~40 files incl. `webSync.test.ts` | No | `webSync` would currently **fail** against `main` (REL-02, measured diff) |
| Windows e2e-sim / ux-review | `windows:e2e-sim`, `ux-review` | scripts + reports | No | Manual |
| Load test | `scripts/loadtest` | up to 2,500 simulated students | No | Manual, historic reports in docs |
| E2E | `docs/E2E_CHECKLIST.md` | Manual checklist | — | Manual |
| CI | `.github/workflows/ci.yml` (+ `android-app.yml`, `windows-app.yml` on their branches) | typecheck, lint, unit, migrations, integration, build, image | — | — |

## Critical untested workflows (no automated coverage)
1. Join → admit → **media actually flows** (audio and share received).
2. Teacher drop → students' mic grant revoked → teacher back → grant restored (unit-tested logic; not exercised with LiveKit).
3. Reconnect after a network loss; Wi-Fi ↔ cellular switch.
4. Screen share codec fallback (REL-04).
5. Cross-client: Windows/Android teacher with web students.
6. Weak network (loss, latency, bandwidth caps).
7. Security regressions: CSRF and authz are unit-tested; there are no HTTP-level tests against the built server.

## Recommended strategy (practical, low cost)
| Layer | What | Where / tooling | Frequency |
|---|---|---|---|
| Unit | Keep the current discipline | `node --test` | Every PR |
| Contract | Golden JSON for `/state`, `/token` and data-packet topics; consumed by Windows and Android tests | `tests/contracts/*.json` | Every PR (all branches) |
| Integration | Existing 4 + join/auth/rate-limit/body-size | Postgres/Redis service containers | Every PR |
| **Media smoke** | LiveKit service container + Next build + Playwright: 1 teacher (fake camera/mic, canvas share) + 2 students. Assert `inbound-rtp` audio and video `bytesReceived` > 0 within 15 s; a hidden student's video stops (DATA-01) | GitHub Actions; Chromium `--use-fake-device-for-media-stream` | Every PR to `main` |
| **Weak network** | Same as above under `tc qdisc netem delay 300ms loss 5% rate 500kbit`; assert audio continuity (concealed samples < 5%) and reconnect < 10 s after a 5-s drop | Nightly | Nightly |
| Load | `scripts/loadtest` at 200 and 500 students on a staging VM; record budgets (LOW_RESOURCE_ENGINEERING_STANDARD) | Staging | Before releases |
| Perf budgets | Bundle-size script + Playwright vitals (as in PERFORMANCE_BENCHMARKS) | CI | Every PR |
| Device | Two reference low-end devices, 30-min class profile | Manual, scripted | Per release |
| Security | `npm audit --omit=dev --audit-level=high` as a failing step; dependency bot | CI | Every PR + weekly |

## Reliability features already present
Join pacing, jittered polls and backoff, webhook queueing, leader locks, worker recycling, graceful SSE drain, fail-open rate limits, fail-closed migrations, a reconnect watchdog.

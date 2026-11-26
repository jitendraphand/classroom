# Audit Progress Checklist

| Subsystem | Reviewed | Depth | Notes |
|---|---|---|---|
| Repo structure, branches, manifests | ✅ | Full | 3 product branches; Windows is a separate history |
| CI/CD workflows | ✅ | Full (main); listed (android, windows) | — |
| Infra: compose, Caddy, LiveKit template, scripts | ✅ | Full | — |
| Docs (24 files) | ✅ | Skimmed; key numbers quoted | Treated as claims, verified where possible |
| Middleware / CSRF / auth / sessions | ✅ | Full read | — |
| Join paths (signed, unsigned, form) | ✅ | Full read of the core | SEC-02/03 |
| LiveKit grants / tokens / webhook | ✅ | Full read of `livekit.ts` (1–200), token route | — |
| `/state`, messages, SSE, hand | ✅ | Partial read + grep | — |
| Rate limiting | ✅ | Grep sweep of all 85 routes | — |
| Admin route guards | ✅ | Grep sweep | All guarded |
| Prisma schema, indexes, migrations | ✅ | Index review | — |
| Background jobs | ✅ | Grep + retention read | — |
| Classroom client (LiveKitRoom options, privacy, publisher, data saver, polls) | ✅ | Targeted reads | `ClassroomRoom.tsx` not read line by line (4,817 lines) |
| Whiteboard | ◐ | Structure only | No issues found at that depth |
| Audio processing | ◐ | Loading path only | — |
| Admin UI pages | ◐ | Route inventory | Not rendered |
| AI teacher app | ◐ | Inventory only | Out of the student/teacher core |
| Android app | ✅ | Manifest, build, lifecycle, LiveKit setup, network config | Not built or run |
| Windows app | ✅ | Security prefs, switches, room options, sidecar design, module drift (measured) | Not built or run |
| Tests (unit) | ✅ | Executed | 598/598 |
| Build + bundle measurement | ✅ | Executed | — |
| Page vitals (throttled) | ✅ | Executed on 3 entry pages | — |
| Integration tests | ❌ | Blocked | No database (no Docker daemon; a local Postgres init as another user was refused by the permission policy) |
| Media-plane measurements | ❌ | Blocked | Running the downloaded LiveKit binary was refused by the permission policy |
| Device profiling (Android/Windows/phones) | ❌ | Not possible here | Plans in each platform report |

Legend: ✅ reviewed · ◐ partially reviewed · ❌ could not be done (reason given).

## Working files (not part of the repo)
Measurement scripts used: the scratchpad `perf/vitals.mjs` and `perf/warm.mjs` (Playwright + CDP). Their method is reproduced in PERFORMANCE_BENCHMARKS.md so it can be re-run.

No application code, configuration or existing files were modified. Nothing was committed, pushed or deployed. The only build artefacts created are `apps/web/.next/` and `apps/web/node_modules/`, both gitignored.

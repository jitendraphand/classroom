# Security and Privacy Audit

No secrets are reproduced in this report. The two SHA-256 digests in `docker-entrypoint.sh` are hashes of previously leaked values, used as a deny-list. They are not secrets.

## 1. Strengths (verified)
- **CSRF:** Origin / `Sec-Fetch-Site` checks on every API method, JSON-only bodies, with a rationale for sslip.io's shared-site problem (`lib/csrf.ts`, `middleware.ts`).
- **Cookies:** `__Host-` prefix over HTTPS, `HttpOnly`, `SameSite=Strict`, sliding expiry (`lib/auth.ts:25-49`).
- **Single active session** for staff (`activeSessionId`); `sessionVersion` revokes on reset or disable.
- **Passwords:** bcrypt cost 12; forced change on first login; login throttle 8/account and 40/IP per 15 min (`lib/rateLimit.ts`).
- **Media authorisation in the token, not the UI:** camera only for the visible sample, mic only when not teacher-muted and the teacher is present, screen share only for teachers, **no data-publish for students** (`lib/livekit.ts:146-174`; it correctly avoids LiveKit's "empty sources = all" trap).
- **Student media privacy:** publisher-side track permissions (`StudentMediaPrivacy.tsx:14-55`).
- **Webhooks** verified with `WebhookReceiver` (signed JWT).
- **No SQL injection paths:** only tagged `$queryRaw` templates (`gradeMaster.ts`, `campusMaster.ts`, `attendanceService.ts`); there is no `$queryRawUnsafe`.
- **No `dangerouslySetInnerHTML`** in the app.
- **Headers:** `X-Frame-Options SAMEORIGIN`, `frame-ancestors 'self'`, `object-src 'none'`, `Permissions-Policy`, HSTS through Caddy.
- **Infra:** Postgres and Redis bound to loopback; the entrypoint refuses placeholder or leaked secrets; containers run non-root (uid 1001); logs are rotated.
- **Electron:** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, `will-navigate` guard, `setWindowOpenHandler` deny, permission handler (`windows:src/main/main.ts:130-134, 751-755, 2591`).
- **Android:** `allowBackup=false`; session cookie encrypted with an Android Keystore key (`CookieVault.kt`); http only for LAN addresses (`ClassLogic.kt:234-256`).
- **Authorization coverage:** every `app/api/admin/**` route calls `requireAdminApi`; every room/teacher/student route resolves its session (grep sweep, plus `tests/authz.test.ts`).

## 2. Findings

| ID | Sev | Vulnerability | Files | Impact | Exploitation | Remediation | Verification |
|---|---|---|---|---|---|---|---|
| SEC-01 | CRITICAL | Vulnerable Next.js 15.5.27 (critical GHSA-2464-fhr4-w9xw image-optimizer RCE; high GHSA-p3m5-59mp-jv5r Server Actions DoS; three moderate) | `apps/web/package.json:28` | Server compromise | Crafted `/_next/image` request (per advisory); not verified against this deploy | `next@>=15.5.29`; `images.unoptimized: true` | `npm audit` clean; `/_next/image` returns 400 |
| SEC-02 | HIGH | Student impersonation: default unsigned SID links and the name-only join form | `lib/schoolJoin.ts:25`, `lib/joinClassForm.ts`, `app/api/join-class/route.ts` | Attendance fraud, seat takeover, outsiders entering minors' classes (gated by admission) | Open `/join?FirstName=…&SID=<classmate>…`, or type a classmate's name | Signed mode by default in prod; flag-gate the form; strict roster; IP limit | Integration test: unsigned link refused in prod mode |
| SEC-03 | MEDIUM | Unthrottled student-row creation | `joinClassForm.ts`, `studentService.ts:43-63` | DB and report pollution | Script POSTs with random names | IP limit on; strict registry before enabling | Load a script, count rows |
| SEC-04 | MEDIUM | Missing per-user rate limits (80/85 route files) | e.g. `api/rooms/[code]/hand/route.ts:64,79` | Teacher-client flooding, server load | Loop `POST /hand` | Route-group token bucket | Test: 31st hand toggle/min → 429 |
| SEC-05 | MEDIUM | No body-size cap; zod <4.6.6 advisory | All `req.json()` routes; `infra/Caddyfile` | Worker memory pressure / DoS | Large JSON POST | Caddy `request_body max_size`; middleware length check; zod 4 | Test: 1 MB body → 413 |
| SEC-06 | LOW | Android OS-level cleartext allowed for all hosts | `res/xml/network_security_config.xml` | Defence in depth only (the app validates) | — | Document; keep the app-level check under test | `ClassLogicTest` covers the address rules |
| SEC-07 | LOW | Chat retained until the next class | `lib/teacherRoom.ts:193` | Privacy / retention | DB access | Purge 24 h after the end | Retention unit test |
| SEC-08 | LOW | 90-min media token TTL | `lib/livekit.ts:34` | A leaked token is valid longer | Reuse a copied token | Keep; rely on room membership checks; document | — |
| SEC-09 | LOW | `source-map-js` advisory (build time) | via postcss | Build-time DoS only | — | Update with postcss | `npm audit` |

## 3. OWASP Top 10 (2021) mapping
| Category | Status |
|---|---|
| A01 Broken access control | Strong server-side checks; **SEC-02** is the weak point (identity, not access control) |
| A02 Cryptographic failures | HS256 sessions with ≥32-char secrets enforced; bcrypt; TLS through Caddy. Bare-IP HTTP deploys are possible (documented); recommend HTTPS-only in production |
| A03 Injection | No raw SQL concatenation; React escaping; zod validation |
| A04 Insecure design | Name-only identity (SEC-02/UX-02) |
| A05 Security misconfiguration | Unused image optimizer enabled (SEC-01); no body cap (SEC-05) |
| A06 Vulnerable components | SEC-01, SEC-05 (zod), SEC-09 |
| A07 Identification/auth failures | Staff auth good; student auth weak by default |
| A08 Software/data integrity | Native apps distributed through Google Drive links with SHA-256 checksums; there is no auto-update and no code-signing statement for the Windows installer (verify) |
| A09 Logging/monitoring | Logs only; no alerting (INF-02) |
| A10 SSRF | No user-controlled outbound fetches found (the webhook is inbound; media-server URLs come from env) |

## 4. Privacy notes
- Non-sampled student video never leaves the device (grant-enforced): a good privacy property.
- Hidden admin observers can watch classes; students see no indicator. Document this in the school's privacy notice. It is a policy decision, not a bug.
- No recording, so no media retention.
- Attendance and personal data: `PARTICIPANT_RETENTION_DAYS=30` for participant rows; Student and Attendance rows are kept indefinitely (expected for school records).

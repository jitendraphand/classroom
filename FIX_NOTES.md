# FIX_NOTES — CODE_REVIEW critical/high fixes

Companion to `CODE_REVIEW.md` (review of `b5c6c32`). This file records what was
actually changed, per finding ID, and what was deliberately left alone.

**Verification performed**

| Check | Result |
|---|---|
| `npm run typecheck` (`tsc --noEmit`) | pass |
| `npm run build` (Next 14.2.35, production) | pass, 14/14 static pages |
| `prisma migrate deploy` on a clean Postgres 16 | all 4 migrations apply |
| Migration 3 backfill executed against real data | 3 unique 6-char codes, unique index enforced |
| `sh -n docker-entrypoint.sh` | pass |
| `docker compose config` | pass; fails loudly with no `POSTGRES_PASSWORD` |
| API behaviour | exercised against a live server (Postgres + Redis + Next standalone) |

`next lint` is **not** runnable: the repo has no ESLint config, so `next lint`
prompts interactively. This is pre-existing and was left alone. Verification used
`tsc --noEmit` plus a production build.

---

## F-01 — Selective video sampling is not enforced server-side · **Critical** · FIXED

The product's central privacy claim was a UI convention. `canPublishVideo` only
reached the LiveKit JWT `metadata`; the grant was `canPublish: true` with **all**
sources for every participant.

- `lib/livekit.ts` — new `PublishPermissions` type and `publishSourcesFor()`.
  `createParticipantToken` takes `allowCamera` and sets `canPublishSources`
  whenever camera **or** mic is disallowed. Unrestricted tokens are left alone
  (no `canPublishSources`) so the default stays "all sources".
  New `setParticipantPublishPermissions()` is the single place that writes
  permissions **and** mutes already-published tracks that are no longer allowed.
  `setParticipantMicAllowed` / `setParticipantCameraAllowed` are thin wrappers;
  `setManyParticipantMics` takes an `inSample` predicate.
- `api/rooms/[code]/token/route.ts` — passes `allowCamera: canPublishVideo`.
- `lib/sample.ts` — `syncCameraPermissionFor()` + `syncSampleMembership()` push
  LiveKit permission changes on every membership change, called from both
  `rotateVisibleSample` and `pinSpeaker`.
- `api/rooms/[code]/mute/route.ts` — reads the current sample and passes it
  through. **This closed a latent privilege bug:** `setParticipantMicAllowed`
  previously wrote `canPublishSources` wholesale, so muting a student who was
  *not* in the sample re-granted them CAMERA. Verified fixed.

**Verified at runtime** — 7 admitted students, `maxVisibleVideos` 1:

```
Maya   canPublishVideo=False  cameraAllowed=False
...
Zoe    canPublishVideo=True   cameraAllowed=True
...
Eli    canPublishVideo=False  cameraAllowed=False
```

Grant matrix (decoded JWTs):

| Case | `canPublishSources` |
|---|---|
| teacher / unrestricted | *(unset → all)* |
| student in sample | *(unset → all)* |
| **student NOT in sample** | `microphone, screen_share, screen_share_audio` |
| student NOT in sample + muted | `screen_share, screen_share_audio` |
| student in sample + muted | `camera, screen_share, screen_share_audio` |

The client (`SelectivePublisher`) is unchanged and remains a UI nicety.

## F-38 — Migration 3 is invalid SQL · **Critical** · FIXED

`SUBSTRING('…', d.rn, 1)` — `ROW_NUMBER()` is `bigint` and PostgreSQL has no
`substring(text, bigint, int)`. Parse error `42883`, failing even on an empty
table. Added the `::int` cast.

Proven both ways against Postgres 16:

```
old: ERROR:  function substring(unknown, bigint, integer) does not exist
new: ABCDE3
```

## F-39 / F-44 / F-45 — Entrypoint · **Critical / High / High** · FIXED

- **Fail-closed.** Removed `|| prisma db push --accept-data-loss`. A failed
  migration now prints how to resolve it and exits 1, leaving the DB untouched.
- **Pass-through args.** `if [ "$#" -gt 0 ]; then exec "$@"; fi` — the previous
  entrypoint swallowed every override, so `docker compose run --rm web <cmd>`
  (e.g. `prisma migrate resolve`, the repair command F-38 needs) started the
  production server instead.
- **`CMD ["node", "server.js"]`** added to the Dockerfile. Without it the base
  image's `CMD ["node"]` is inherited and the new pass-through is unreachable.
- **`trap 'exit 143' TERM INT`** + `stop_grace_period: 45s`, so `docker stop`
  during a migration no longer leaves a half-applied `_prisma_migrations` row.
- **DB URL parsing** now uses `new URL()` — the old regex mis-parsed any password
  containing `@` and could not read IPv6. Verified against `@`-in-password,
  malformed, and `[::1]` inputs.
- `set -e` → `set -eu`.

## F-13 — Unbounded whiteboard `PUT` · **High** · FIXED

- Server: zod schema, 1 MB raw body ceiling, 512 KB serialised-snapshot ceiling,
  correct 400/413 split, and `JSON.parse` on GET wrapped so a corrupt Redis value
  degrades to an empty board instead of a 500 on every poll for every participant.
- Client (`Whiteboard.tsx`): mirrors the 512 KB cap before the round trip, with a
  one-shot console warning.

Two bugs found in my own first attempt, both caught by runtime testing:
`z.unknown()` is implicitly optional in zod, and `.refine()` runs on zod's
*output* (which always carries the key), so `{ "nope": 1 }` passed and returned a
misleading "too large". Now the key is checked on the raw body, and a
non-serialisable value returns 400 rather than 413.

Verified: malformed → 413, missing snapshot → **400**, valid → 200, 425 KB → 200,
1.2 MB → 413, student without permission → 403, corrupt Redis → 200.

## §4 Security — compose hardening · **Critical** · FIXED

- **Postgres** `listen_addresses=127.0.0.1` (the official image forces `*`;
  5432 was listening on every interface). Added 2 GB-appropriate tunables:
  `shared_buffers=256MB`, `effective_cache_size=1536MB`,
  `maintenance_work_mem=128MB`, `max_wal_size=512MB`, `max_connections=50`,
  plus `shm_size: 256mb`.
- **No silent default password.** `${POSTGRES_PASSWORD:?…}` in both the
  `postgres` service and the web `DATABASE_URL`. A missing value now aborts
  `docker compose` instead of booting with `classroom_dev_password`.
- **Redis** `--maxmemory 192mb --maxmemory-policy allkeys-lru --appendfsync
  everysec`, keeping `--bind 127.0.0.1` and AOF. Previously `maxmemory 0` +
  `noeviction` with unbounded `room:*` keys.
- `.env.example`: `POSTGRES_PASSWORD` placeholder changed to an explicit
  "REQUIRED, generate with `openssl rand -hex 24`"; added a security header
  block and a warning that the `*_SECRET` placeholders are **not** generated by
  any script here.
- `Dockerfile:20` build-time `DATABASE_URL` changed from a real-looking
  credential (baked into the layer, for a `postgres` host that does not exist in
  this host-networked stack) to a non-routable dummy.

**No secrets were rotated and git history was not rewritten** — see "Skipped".

## F-21 — Duplicate `/state` poller · **High** · FIXED

`ClassroomRoom.tsx` ran a second 2 s `/state` poller alongside
`useRoomState`'s, on the hottest endpoint in the app, for no behavioural gain.
Deleted, with a comment explaining why. `useRoomState` already covers the ENDED
transition via `onClassEnded()`. The remaining `/state` call in
`ClassroomRoom.tsx` is the one-shot `load()` on mount, not a poller.

## F-05 — Chat history leaked across class sessions · **High** · FIXED

A teacher's permanent room row is reused forever and `Message` rows were never
cleared, so the next class saw the previous class's chat — including teacher DMs
naming individual students. `startOrReopenTeacherRoom` now deletes the room's
messages on `ENDED → WAITING`.

Verified: 4 messages before end → 0 after end → 0 after reopening **with the same
permanent code** (`US2WKB` unchanged, so teacher codes are intact).

## F-02 — Self-mute did not release the sticky speak-pin · **High** · FIXED

Pins lasted until *teacher* mute only, so a student who spoke once and then muted
their own mic held a reserved slot for the rest of the class.

- `api/rooms/[code]/sample/pin/route.ts` — accepts `pinned: false` to release
  (teacher-authorised, same as pinning).
- `ClassroomRoom.tsx` — the teacher client now handles `RoomEvent.TrackMuted`
  and unpins that identity. Releases are deliberately **not** rate-limited (only
  pins are), so a mute can never be swallowed.
- `lib/sample.ts` — `unpinSpeakerByParticipant()`; `pruneStickyPins()` caps the
  hash at `MAX_STICKY_PINS` (12) keeping the most recent, so stale pins can never
  monopolise all 6 slots.
- `leave` now unpins the departing student too.

Verified: pin → 1 hash entry; unpin → empty; unpin again → `wasPinned:false`.

## F-23 — Rotation stampede · **High** · FIXED

`ensureSampleFresh` was check-then-act with no lock, so every concurrent client
rotated on a stale marker. Now a `SET NX PX 3000` lock on
`room:{code}:rotate-lock`; losers read the existing sample and pick up the new one
on their next poll. If the sample is genuinely empty the loser still rotates, so
a first-ever rotation cannot be skipped. The lock is released in a `finally`.

Verified: 40 concurrent `/state` polls → one rotation, lock cleaned up
(`EXISTS 0`), rotation still advances on the interval.

## F-09 / F-30 — Chat query · **Medium/High** · FIXED

- `orderBy: createdAt desc` + `take: 500` + reverse, so the cap keeps the
  **newest** 500. Previously the oldest 500, so new messages silently stopped
  appearing once a class crossed the threshold.
- Student visibility moved into the Prisma `where` clause
  (`BROADCAST` ∪ own `TEACHER` ∪ `DIRECT` to self) instead of loading every row
  and filtering in JS — a data-minimisation improvement as well as a perf one.

Verified scoping with 4 messages: Maya sees
`['maya->teacher', 'EVERYONE READ THIS', 'PRIVATE TO MAYA']`; Zoe sees
`['zoe->teacher', 'EVERYONE READ THIS']`; teacher sees all 4; waiting student
403.

## F-08 — Waiting students received the full roster · **Medium** · FIXED

`resolveRoomAccess` treats any non-`LEFT` participant as "in room", so a `WAITING`
student got the whole `admitted[]` array including every LiveKit identity, plus
`visibleIdentities` — and the lobby page re-downloaded it every 2 s. Now a waiting
student gets only room metadata + their own `me`, and the route returns **before**
the sample/Redis reads they do not need.

Verified: `me.status=WAITING, admitted=0, visibleIdentities=[]`; admitted
students and teachers are unaffected.

## F-07 — Stage stuck on `screen` · **Medium** · FIXED

Stopping the share via the browser's own "Stop sharing" bar left Redis
`stage=screen`, pinning every student to an empty "Waiting for teacher screen…".
`RoomInner` now listens for `RoomEvent.LocalTrackUnpublished` and posts `idle`.
A `stageSwitchRef` guard prevents the teardown inside `selectTab('board')` from
racing `postStage('whiteboard')`.

## F-12 / F-18 — Role-filter consistency · **Low** · FIXED

- `leave`: teacher-issued removal is now scoped to `role: 'STUDENT'`, so a
  teacher cannot mark a TEACHER participant `LEFT` via the endpoint.
- `leave`: **also fixed a pre-existing bug** — a teacher clicking "Leave class"
  sent `{}`, resolved to `null` (teachers have no student cookie) and got a 403,
  so they appeared to leave while their participant row stayed `ADMITTED`. Now a
  teacher with no `participantId` resolves to their own teacher participant.
- `admit`: the waiting-set rebuild now filters `role: 'STUDENT'` like every other
  query in that file.

## F-55 — `next@14.2.18` below the CVE-2025-29927 fix · **Medium** · FIXED

Bumped to **14.2.35** (latest 14.x, exact pin retained) and added a `typecheck`
script. `package-lock.json` updated in step.

- `CVE-2025-29927` (middleware subrequest authz bypass, CVSS 9.1) is resolved —
  no longer in `npm audit`. It was never reachable here (no `middleware.ts`).
- Remaining `next` advisories require `>= 15.5.16`, i.e. a major bump, which is
  out of scope for this pass. The reachable ones are **DoS-only** and the critical
  one (Image Optimizer `remotePatterns` DoS) is **not reachable**: the app has no
  `next/image` usage and no `images` config.
- The `nanoid` advisory ("predictable when given non-integer values") is also not
  reachable: `lib/codes.ts` uses `customAlphabet(alphabet, 6)`, not a numeric
  argument.

## F-15 / F-58 — Dead `chromeVisible` auto-hide · **Low** · FIXED

`chromeVisible` was only ever set to `true`, so the opacity branch was
unreachable and "tap to show controls" never fired. Removed the state, the no-op
`bumpChrome`, the dead timer ref, and the root `onPointerDown`/`onTouchStart`
handlers. Student controls are always visible, which is the intended behaviour.

Also removed three dead exports flagged in the review:
`sample.ts: unpinSpeakers`, `redis.ts: getStageMode`,
`redis.ts: getWhiteboardWriteAllowed` (all 0 call sites; the latter two had been
inlined at their single call site in `state/route.ts`).

## Bonus — migration/schema drift

`prisma/migrations/20240925000000_init` declared
`"maxVisibleVideos" INTEGER NOT NULL DEFAULT 10` while `schema.prisma` says
`@default(6)`, so a migrations-built database did not match a `db push`-built one
and `migrate diff` reported a diff on every run. Added
`20260927213000_room_maxvisible_default` to align them. Application behaviour is
unchanged (room creation always passes an explicit clamped value), but the
history now replays to the live schema.

---

## Skipped (and why)

- **F-20 / leaked LiveKit key in git history.** The real 256-bit secret is in the
  initial commit `d62c07b` and is still the value in the working `.env`. Fixing
  it properly means (a) rotating `LIVEKIT_API_SECRET` and `NEXTAUTH_SECRET` on
  the deployment, and (b) `git filter-repo` + force-push. Both were explicitly
  out of scope. **This is still the single highest-risk item in the review and
  needs a human.** Until it is done the deployment should not be exposed on a
  public IP.
- **F-10 no rate limiting.** Real and important, but a meaningful new feature
  (middleware + storage + policy per endpoint) rather than a small patch, and
  "inventing new features" was out of scope. The `SET NX PX` pattern needed is
  already used by `pinSpeaker` and by the new rotation lock, so it is a
  straightforward follow-up.
- **F-24 whiteboard poll frequency / payload frequency.** The 1.5 s
  full-snapshot poll is the real cost driver. Fixing it properly needs a version
  counter and changes the sync protocol; the payload is now *bounded* (F-13) but
  the *frequency* is unchanged.
- **F-03 6 h token TTL / no token refresh.** F-01 made the token's camera grant
  authoritative at mint time, but a class longer than the TTL, and mute changes
  for already-connected students, still rely on the fire-and-forget LiveKit call.
  The call was hardened (both flags always sent together, errors surfaced to
  `console.warn`) but still `void`-ed in `mute/route.ts` awaiting a refresh loop.
- **F-31 image size / F-21b polling architecture / F-35 TURN / F-27 resource
  limits / F-41 push-not-poll.** Real and in the report, but each is a
  multi-file change beyond "small, correct patches". Compose got the security
  and Redis/Postgres settings; the log caps, `mem_limit`s and LiveKit healthcheck
  were left for a follow-up.
- **`next lint`.** No ESLint config exists in the repo; `next lint` prompts
  interactively. Pre-existing. Verification used `tsc --noEmit` + a production
  build.

## Noted, not changed

`POST /rooms/{code}/hand` still returns 401 if a teacher sends the bare
`{ "raised": true }` shape instead of `{ "participantId", "raised" }` (F-10 in the
review). The UI only ever sends the `participantId` form, so this is latent, and
changing the union's error semantics was not worth the churn in this pass.

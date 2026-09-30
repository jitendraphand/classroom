# Code Review — Classroom (Next.js + LiveKit + Postgres + Redis + Docker)

**Scope:** full repository at `b5c6c32` — `apps/web` (App Router, ~5.5k LOC app code), `infra/`, `scripts/`, `docker-compose.yml`, `docs/`, Prisma schema + 3 migrations.
**Method:** every tracked file read. Infra findings were additionally verified by building the image, booting the real compose stack, and running the migrations. All app-level claims below were verified by reading the code path end-to-end.

---

## Executive summary

The architecture is genuinely good. Selective video publishing, a waiting room, sticky speaker pins, a gated tldraw whiteboard, and a clean teacher/student split are all well-chosen, and the privacy framing ("non-sampled video never leaves the student device") is the right product instinct. The code is readable and mostly well-factored.

The problem is that **the most important guarantee in the product is not actually enforced**, and the app will not survive its own stated scale target.

Three things dominate:

1. **The core privacy promise is client-side only.** `canPublishVideo` is returned to the browser and put in LiveKit JWT *metadata*, but it is never applied to the grant's `canPublishSources`. A non-sampled student's token is `canPublish: true` with all sources. One modified client, or one bug in the 2-second polling window, publishes an arbitrary number of camera streams to the SFU. Everything the README promises about privacy is a UI convention. (F-01)
2. **Polling is ~3× redundant and each poll is expensive.** Every client runs *two* identical 2-second `/state` pollers plus a 1.5-second full-snapshot whiteboard poller. Each `/state` call costs 4–5 Postgres round trips and 6–8 *sequential* Redis round trips. At the documented 150 students that is ~650 queries/sec and ~1,050 Redis RTTs/sec against a 2 GB VPS. (F-08, F-09, F-10)
3. **The LiveKit API secret is in git history and is still the deployed secret.** Commit `d62c07b` contains the real 256-bit key, and the same value is in the working `.env` today, never rotated. That key is admin on the SFU. (F-20)

Also worth calling out: migration 3 contains invalid SQL and **fails on a clean database**, which is why the entrypoint's `|| prisma db push --accept-data-loss` fallback has silently become the normal schema path (F-22, F-23). And because the teacher always reuses the same `Room` row, **chat history from a previous class session is shown to the next class's students** (F-05).

**Verdict:** the MVP works for a 5–10 person demo. It should not be exposed on a public IP in its current state, and the scale claim in the README is off by roughly two orders of magnitude.

**Finding count:** 61 numbered findings — **5 Critical, 17 High, 28 Medium, 10 Low** — plus 2 further Critical infra issues tabulated in §4 (Postgres internet-reachable; placeholder secrets shipped as the documented deploy path) and 1 positive verification (no XSS vectors). **69 issues total.**

---

## Severity summary

| Severity | Count | Theme |
|---|---|---|
| Critical | 5 + 2 | Unenforced video sampling; leaked LiveKit key; broken migration; `db push --accept-data-loss`; polling cost per request; unbounded whiteboard PUT; Postgres exposed; placeholder secrets shipped |
| High | 17 | Cross-session chat leak; self-mute doesn't unpin; 6h unrefreshed tokens; duplicate poller; rotation stampede; whiteboard snapshot flood; no rate limits; 1.4 GB image; no TURN; port range vs. claimed scale; no tests/CI |
| Medium | 28 | Redis chatty-ness, stale stage, 500-message cap, roster leak to waiters, host networking, missing healthchecks, resource limits, Redis eviction, env precedence, typing at the authz boundary |
| Low | 10 | Dead code, docs drift, `chromeVisible` no-op, script nits, redundant index, `/api/health` leak |

---

# 1. Functionality / product correctness

### F-01 · Selective video sampling is not enforced server-side · **Critical**
**Files:** `apps/web/src/app/api/rooms/[code]/token/route.ts:40,47-61`, `apps/web/src/lib/livekit.ts:52-64`

`canPublishVideo` is computed and then used *only* as JWT `metadata` and a JSON field:

```ts
// token/route.ts:40
const canPublishVideo = isTeacher || sample.visible.includes(participant.livekitIdentity);
// token/route.ts:55-60
metadata: { role, participantId, canPublishVideo, mutedByTeacher },
```

`createParticipantToken` (`livekit.ts:52-64`) sets `canPublish: true` and only ever constrains `canPublishSources` for the *mic* case. There is no `CAMERA` exclusion. `grep` confirms it: the only two `canPublishSources` writes are `SOURCES_NO_MIC` in `livekit.ts`.

**Impact:** the entire privacy model is client-side. `SelectivePublisher` (`ClassroomRoom.tsx:1129-1196`) unpublishes when `canPublishVideo` flips false — but that value arrives from a 2s poll. A student can:
- patch the client, or
- simply never process the poll response,

and publish camera video to LiveKit continuously. The SFU will happily forward it and the teacher will receive it. This also directly contradicts `README.md:44` ("Non-sampled video **never leaves the student device**") and the landing page copy.

**Fix:** enforce in the grant and in the room permission.

```ts
// livekit.ts
const SOURCES_NO_CAMERA = [TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO];
// token/route.ts
const token = await createParticipantToken({
  ...,
  canPublishVideo,
  noCamera: !canPublishVideo,      // -> canPublishSources = SOURCES_NO_CAMERA
});
```

Then, because sample membership changes every 8s, also push the change through LiveKit rather than relying on the client to re-mint:

```ts
// when rotation changes membership, for identities that entered/left the sample:
await setParticipantCameraAllowed(code, identity, inSample); // updateParticipant(permission.canPublishSources)
```

Keep the client-side logic for the UI, but treat the server grant as the source of truth.

---

### F-02 · Self-muting a student does not release their sticky speak-pin · **High**
**Files:** `apps/web/src/lib/sample.ts:36-56,64-104`, `apps/web/src/app/api/rooms/[code]/mute/route.ts:83-86`

Server-side pins live in `room:{code}:pinned-speakers` with **no TTL** (by design — `.env.example:63` "pins now stick until mute"). The only things that remove one:

| Path | Trigger |
|---|---|
| `rotateVisibleSample` | pin's identity is no longer an `ADMITTED` student (sample.ts:83-87) |
| `unpinSpeaker` | **teacher** mutes the student (`mute/route.ts:85`) |
| `clearPinnedSpeakers` | teacher mutes everyone |
| `pinSpeaker` | participant is `mutedByTeacher` (sample.ts:155-158) |

There is **no path for the student muting their own mic.** A student who speaks once, then clicks their own mic, keeps a reserved slot in the visible sample — and keeps publishing video — until the teacher explicitly mutes them. Over a class this leaks slots and starves the rotation pool.

**Fix:** have the student report their own mic state, or derive the pin from `TrackMuted`. Cheapest correct fix: on the teacher client, when `RoomEvent.TrackMuted` fires for a participant, call `POST /sample/pin` with `{identity, pinned:false}`, and add a server-side branch that unpins. Also worth adding a bounded max-pins guard so a pile of stale pins can never fill all 6 slots.

---

### F-03 · Tokens live 6 hours and are never refreshed · **High**
**Files:** `apps/web/src/lib/livekit.ts:49` (`ttl: '6h'`), `apps/web/src/components/classroom/ClassroomRoom.tsx:2166-2176`

The token is fetched exactly once, in `load()`, and stored in `tokenData`. It is never re-minted for the life of the page.

**Impact:**
- A class longer than 6h disconnects with no recovery — `LiveKitRoom` has no `onReconnecting`/`onDisconnected` recovery path beyond `onError` logging (`ClassroomRoom.tsx:2258`).
- **Mute does not reach a connected student.** The DB flag is checked at mint time (`token/route.ts:44-45`) and in the 2s state poll. The actual LiveKit enforcement is `setParticipantMicAllowed`, which is called as `void …` — fire-and-forget (`mute/route.ts:81`). If that call fails (LiveKit restarting, participant not yet connected) the student keeps a valid 6h token with mic permission and can publish audio. The 2s poll makes the *UI* show "muted by teacher", but the button is disabled client-side only.
- Same problem in reverse: `canPublishVideo` changes every 8s and the token is frozen (see F-01).

**Fix:** mint short-lived tokens (10–15 min) and refresh them on a timer *and* immediately when `canPublishVideo` / `mutedByTeacher` changes. `await` the LiveKit mute call and surface a failure rather than discarding it.

---

### F-04 · Fullscreen leave-kick permanently removes students on any fullscreen exit · **High**
**Files:** `apps/web/src/components/classroom/ClassroomRoom.tsx:1431-1494`

`onFsChange` fires a full `POST /leave`, which sets `status: 'LEFT'` (`leave/route.ts:38-41`) and clears the student cookie — then `router.push('/')`.

**Impact:** any `fullscreenchange` that drops out of fullscreen ejects the student from the roster permanently. On Windows/Linux Chrome, **Alt+Tab, Win+Tab, F11, opening the browser devtools, and clicking a notification that steals focus all exit fullscreen.** The student is silently dropped from class and must re-queue through the waiting room. This is a data-loss-of-class event, not a UX papercut.

The guard is reasonable in principle (`if (!entered) return` at line 1463 avoids kicking browsers that never granted fullscreen), but "left fullscreen" is a far too broad proxy for "left the class."

**Fix:** this is an *attendance* signal, not a *leave* action. Mark attendance (a `kickedFullscreen` / `lastSeenAt` flag + a client-side "you left fullscreen, rejoin" screen) and do **not** call `/leave`. If the hard-kick is a hard product requirement, at minimum add a 15-second grace countdown with a "rejoin" button, and skip the kick when `document.visibilityState === 'hidden'` transitions (alt-tab) rather than a real user-initiated exit. Also consider `Esc` — that key is the single most common accidental trigger.

---

### F-05 · Chat history leaks across class sessions · **High**
**Files:** `apps/web/src/lib/teacherRoom.ts:74-107` (room reuse), `apps/web/src/app/api/rooms/[code]/messages/route.ts:101-121`

A teacher's permanent code maps to exactly one `Room` row, reused forever. `startOrReopenTeacherRoom` flips an `ENDED` room back to `WAITING` and — unlike the teacher/participants — **never touches `Message` rows**. `GET /messages` filters only on `roomId`, so:

> Teacher ends Monday's class. On Tuesday's class, every admitted student sees Monday's chat history — including the teacher's DMs to individual students, addressed by name.

This directly contradicts `README.md:221` ("Chat persists in Postgres while the room is LIVE/WAITING") and `README.md:40` ("cleared from API when room is ENDED"). The API does return `[]` while `ENDED`, but it is not cleared, so the moment the room reopens it all comes back.

**Fix:** either (a) delete `Message` rows in the `END`→`WAITING` reopen branch of `startOrReopenTeacherRoom`, or (b) add a `sessionId`/`startedAt` to `Message` and scope all reads to the current session. (a) is a one-liner and matches the documented intent; (b) is better if you ever want class archives. Either way, fix the README.

---

### F-06 · Rotation reshuffles every slot from scratch, causing publish/unpublish churn · **Medium**
**Files:** `apps/web/src/lib/sample.ts:90-95`

```ts
const keepPinned = shuffle(pinnedInRoom).slice(0, Math.min(n, pinnedInRoom.length));
const fill = shuffle(rest).slice(0, Math.max(0, n - keepPinned.length));
const sample = [...keepPinned, ...fill].slice(0, n);
```

Every 8 seconds the non-pinned portion is re-shuffled from nothing, so **no student survives a rotation unless pinned**. With 150 students and 6 slots, a given student's expected visible time is ~24%, and they churn in and out roughly every 8s.

**Impact:** each transition makes the client `createLocalVideoTrack(...)` + `publishTrack` and later `unpublishTrack` + `track.stop()` (`ClassroomRoom.tsx:1129-1196`), which is a full `getUserMedia` + encoder init. At 150 students that is ~11 camera-track start/stops per second at the SFU. The teacher's mosaic also blanks and refills tiles every 8s. The requirement says "rotation", which this satisfies, but the churn is avoidable and visible.

**Fix:** keep a residency score. Prefer the smallest subset of the *current* sample that overlaps the previous one, so at most `k` (e.g. 1–2) slots actually change per tick:

```ts
const prev = await redis.smembers(keys.visible(roomCode));
const keep = shuffle(prev.filter(id => !pinned.has(id))).slice(0, Math.max(0, n - pinnedInRoom.length));
const fill = shuffle(rest.filter(id => !keep.includes(id) && !pinned.has(id))).slice(0, n - keep.length - pinnedInRoom.length);
```

---

### F-07 · Teacher `stage` sticks in `screen` when sharing is stopped from browser UI · **Medium**
**Files:** `ClassroomRoom.tsx:1506-1522,1524-1541`, `apps/web/src/app/api/rooms/[code]/stage/route.ts:28`, `infra/livekit.yaml` (no webhook)

`postStage` is only called from `toggleScreen` and `selectTab`. If the teacher stops sharing via the **browser's** "Stop sharing" bar (a very common path, and the one Chrome surfaces automatically), `screenOn` state goes stale, Redis still holds `stage=screen`, and every student is pinned to `TeacherScreenStage`, which renders "Waiting for teacher screen…" indefinitely. There is no LiveKit webhook (`infra/livekit.yaml` has no `webhook:` block) and no `TrackUnsubscribed` handler that resets the stage.

**Fix:** listen for `RoomEvent.LocalTrackPublished` / `LocalTrackUnsubscribed` on `Track.Source.ScreenShare` and POST `idle` on unpublish. Add `webhook: { urls: [...] }` to `livekit.yaml` for the server-authoritative version.

---

### F-08 · Waiting-room students can read the full admitted roster · **Medium**
**Files:** `apps/web/src/lib/auth.ts:139-140`, `apps/web/src/app/api/rooms/[code]/state/route.ts:85-134`

```ts
const studentInRoom = !!student && student.roomId === room.id && student.status !== 'LEFT';
```

A `WAITING` participant therefore resolves to `mode: 'student'`, and `/state` returns the full `admitted[]` array — every participant's `id`, `displayName`, `livekitIdentity`, `mutedByTeacher` and hand state — plus `visibleIdentities[]`. The UI never renders this for a waiter, but the API does.

**Impact:** anyone in the lobby (i.e. anyone who has the room code) learns the full class roster and internal LiveKit identities before admission. It also means the lobby page's `poll()` (`join/[code]/page.tsx:40`) downloads this every 2 seconds.

**Fix:** gate the `/state` response on `me.status === 'ADMITTED'` for the `admitted`/`visibleIdentities`/`raisedHands` fields, returning only `me` + `status` + `name` for waiters.

---

### F-09 · Chat history caps at the *oldest* 500 messages · **Medium**
**File:** `apps/web/src/app/api/rooms/[code]/messages/route.ts:101-106`

```ts
orderBy: { createdAt: 'asc' },
take: 500,
```

Once a class exceeds 500 messages the newest ones are silently dropped — the query always returns the first 500 chronologically. Combined with the absence of message rate limits (F-11), a single spamming student can make the chat unusable for everyone for the rest of the class.

**Fix:** `orderBy: { createdAt: 'desc' }, take: 500` then reverse in JS, or paginate with a cursor. Add a per-participant send rate limit.

---

### F-10 · The teacher cannot raise a hand, and the student `hand` shape 401s for teachers · **Low**
**File:** `apps/web/src/app/api/rooms/[code]/hand/route.ts:7-15,37-53`

The schema is a union of `{raised}` (student) and `{participantId, raised}` (teacher). A teacher posting `{raised: true}` falls into the student branch, fails `access.mode !== 'student'`, and gets a 401. Only the `{participantId}` form works, so the API shape is inconsistent with its own name. The UI only ever sends `participantId` from the roster, so this is latent.

**Fix:** reject a teacher who sends the bare form with `400` and a clear message, or accept `{raised}` for teachers as "raise/lower the room".

---

### F-11 · No rate limiting anywhere · **High**
**Files:** every `apps/web/src/app/api/**/route.ts`

There is not a single rate limiter, throttle, or IP/identity-based limiter in the codebase.

| Endpoint | Unbounded abuse |
|---|---|
| `POST /api/auth/login` | bcrypt cost 12 ≈ 300ms CPU **per attempt** → 4 concurrent requests saturate a core; also unthrottled credential stuffing |
| `POST /api/auth/register` | unlimited `Teacher` rows, each triggering `allocateUniqueCode()` = 2 `findUnique` |
| `POST /api/rooms/{code}/join` | unlimited `Participant` rows; the room code is the *only* credential, and `state` returns 404 vs 200, giving a clean enumeration oracle |
| `POST /api/rooms/{code}/messages` | unbounded `Message` rows → F-09 |
| `PUT /api/rooms/{code}/whiteboard` | see F-13 |
| `GET /api/health` | unauthenticated, does a `SELECT 1` + `PING` per hit |

**Fix:** add a small fixed-window limiter keyed on IP for unauthenticated routes and on session/identity for authenticated ones. Redis is already there and fast. The 2s Redis `SET NX PX` pattern in `pinSpeaker` (`sample.ts:160-166`) is a good template to generalise.

---

### F-12 · `POST /leave` can remove the teacher participant and ignores role · **Low**
**File:** `apps/web/src/app/api/rooms/[code]/leave/route.ts:29-53`

```ts
target = await prisma.participant.findFirst({ where: { id: participantId, roomId: room.id }, ... });
```

No `role: 'STUDENT'` filter (contrast `hand/route.ts:43` and `mute/route.ts:69`, which both filter correctly). A teacher-supplied id can mark the teacher participant `LEFT`, which then makes `startOrReopenTeacherRoom`'s "ensure teacher participant is admitted" branch the only recovery. Not exploitable by a student, but inconsistent and worth a filter.

---

### F-13 · `PUT /whiteboard` accepts an unbounded, unvalidated payload from any admitted participant · **High**
**Files:** `apps/web/src/app/api/rooms/[code]/whiteboard/route.ts:56-78`, `apps/web/src/app/api/rooms/[code]/whiteboard/write/route.ts`

```ts
const body = await req.json();
await redis.set(keys.whiteboard(code), JSON.stringify(body.snapshot ?? body), 'EX', 60 * 60 * 6);
```

No zod schema, no size cap, no shape check. App Router route handlers have **no default body size limit** (the `serverActions.bodySizeLimit: '2mb'` in `next.config.mjs:5-9` applies only to Server Actions, and there are none — `grep "use server"` returns nothing).

Once the teacher enables "Allow students to draw" (`wbWrite=1`), any admitted student can `PUT` a multi-hundred-megabyte JSON blob, which is `JSON.stringify`'d and written to Redis. Redis is running with `--appendonly yes` and `maxmemory 0` / `noeviction` (`docker-compose.yml:29`), so this is a **direct OOM of the whole stack on a 2 GB box**, and the AOF rewrite makes it durable on disk.

The mirror risk: `GET` does `JSON.parse(snapshot)` with no try/catch (`route.ts:51`), so a corrupt value turns into a 500 on every whiteboard poll for every participant.

**Fix:**
```ts
const schema = z.object({ snapshot: z.unknown() })
  .refine(v => JSON.stringify(v).length <= 512_000, 'snapshot too large');
const parsed = schema.parse(await limitedJson(req, 1_000_000));
```
and `try/catch` the `JSON.parse` on read. Enforce the same cap in `Whiteboard.tsx`'s `persist` (it currently `JSON.stringify`s the whole tldraw document with no bound).

---

### F-14 · `x-classroom-as` / `?as=student` is an unauthenticated identity switch · **Low**
**Files:** `auth.ts:130-140`, `hand/route.ts:22-24`, `messages/route.ts:22-25`, `state/route.ts:12-14`, `token/route.ts:12-15`, `whiteboard/route.ts:17-20`

Any client can send `?as=student` or `X-Classroom-As: student` and force `forceStudent`. The good news: this is **downgrade-only**. `resolveRoomAccess` returns `mode: null` for a teacher who forces student mode without a matching student session, so it cannot escalate — every teacher-only route uses `getTeacherSession()` directly and ignores the header entirely.

The residual risk is availability/UX, not privilege: the `act_as` cookie (`auth.ts:107-115`, 12h maxAge) is browser-wide, not tab-scoped, so a teacher who visits a join link and clicks "Continue as student" silently loses teacher powers on `/api/rooms/{code}/state` in *all* tabs for 12 hours. `teacher/dashboard` and `teacher/room` both POST `mode: 'clear'` to compensate, but any other tab is stuck.

**Fix:** keep the header (it is needed for the single-browser E2E flow) but return a distinct `409` with a hint when `forceStudent` is set and no student session exists, instead of a generic `public: true` response, so the client can surface "you are signed in as a teacher" rather than silently rendering the join page.

---

### F-15 · Floating "chrome auto-hide" is a no-op · **Low**
**File:** `ClassroomRoom.tsx:1286, 1413-1428, 1680`

`chromeVisible` is initialised `true` and **never set to `false`** — `bumpChrome` only ever calls `setChromeVisible(true)`, and the cleanup timer that was presumably meant to hide it was removed (the comment at 1416 says "Keep student controls visible"). The `opacity-100 / pointer-events-none opacity-0` branch at line 1680 is dead. `bumpChrome` itself is now an empty wrapper. Either implement auto-hide or delete the state, the handler and the class branch.

---

### F-16 · Two competing "sticky speaker" implementations · **Medium**
**Files:** `ClassroomRoom.tsx:573, 676-716` (client `stickySpeakersRef`) vs `lib/sample.ts:36-56` (Redis `pinned-speakers` hash)

The teacher's client independently tracks who is "sticky" (add on `ActiveSpeakersChanged`, drop on `isMicMuted`), and separately POSTs `/sample/pin` to build the *server* set. The two sets are never reconciled. The mosaic renders from the client set, the publish permission comes from the server set. A student can be shown as "Speaking" in the mosaic while the server has ejected them from the sample (blank tile), or vice versa.

**Fix:** make the server set authoritative and have `/state` return `pinnedIdentities: string[]`; drive the mosaic from that. Delete `stickySpeakersRef`. This also fixes F-02 for free.

---

### F-17 · Teacher live-video tab is a full subscribe-all grid; the "mosaic" only exists in presentation mode · **Low (by design, but worth stating)**
**Files:** `ClassroomRoom.tsx:73-212` (`ParticipantGrid`), `2080-2089`

`TeacherPeersFloat` is rendered only when `stageMode`/`effectiveStage` is `screen` or `whiteboard` (line 2080). In the plain video tab, `ParticipantGrid` uses `useTracks([...], { onlySubscribed: true })` and renders every subscribed camera with no slot limit and no "In sample" enforcement — the sample cap is applied only by `setSubscribed(true)` on whatever LiveKit happens to push.

`ParticipantGrid` also takes a `visibleIdentities` prop that it explicitly discards (`void _visibleIdentities`, line 84) — the one place where the sample cap *could* be enforced in the video tab, it isn't.

**Fix:** either apply `visibles` in `ParticipantGrid` (the prop is already threaded there) or remove the prop and document that the video tab is uncapped.

---

### F-18 · `admit` rebuilds the waiting set without a role filter · **Low**
**File:** `apps/web/src/app/api/rooms/[code]/admit/route.ts:50-54`

```ts
const stillWaiting = await prisma.participant.findMany({ where: { roomId: room.id, status: 'WAITING' }, select: { id: true } });
```

Every other query in the file filters `role: 'STUDENT'`. If a teacher participant ever lands in `WAITING`, it gets pushed into the `waiting` Redis set and would appear in the teacher's own admit list. Add the filter for consistency.

---

### F-19 · Verified-correct: no XSS vectors · *(positive finding)*
`grep -rn "dangerouslySetInnerHTML|innerHTML|eval(|new Function" apps/web/src/` → **no matches**. Chat bodies render via `{m.body}` in JSX (`Chat.tsx:318`), which React escapes. `Avatar` (`ui/Avatar.tsx:19-23`) slices into initials and renders text. The whiteboard path is the one place attacker-influenced structured data lands, and tldraw's `loadSnapshot` validates records — mitigated by F-13's need for a size/shape cap.

---

# 2. Performance

### F-20 · LiveKit API secret is committed in git history and still in use · **Critical** *(infra)*
**Files:** `infra/livekit.yaml:12-13` (git-tracked), `scripts/sync-livekit-keys.sh:25-44`, history commit `d62c07b`

```
$ git log --all -p -- infra/livekit.yaml
+  devkey: 89ee…<redacted: leaked secret, rotated>
```

The working-tree file now has the placeholder, but the real 256-bit secret is in the initial commit and is **the same value as the one in the local `.env` today** — never rotated. `infra/livekit.yaml` is the file bind-mounted at `docker-compose.yml:44`.

That secret is **admin on the LiveKit server** (Twirp API on `:7880`, bound `0.0.0.0` per `livekit.yaml:2-3`, and opened by `docs/DEPLOY-VPS.md`): mint tokens for any room/identity, list and delete rooms, remove participants, rewrite room config. Anyone who has read the repo can take over every live class.

**Fix, all four steps:**
```bash
LIVEKIT_API_SECRET=$(openssl rand -hex 32)   # in .env
NEXTAUTH_SECRET=$(openssl rand -hex 32)      # in .env
./scripts/sync-livekit-keys.sh && docker compose up -d livekit web

echo 'infra/livekit.yaml' >> .gitignore && git rm --cached infra/livekit.yaml
git filter-repo --path infra/livekit.yaml --invert-paths --force   # then force-push
```
Ship `infra/livekit.yaml.example` with a placeholder; have `sync-livekit-keys.sh` generate the keypair if absent so a placeholder can never reach the mounted file.

---

### F-21 · Every client runs two identical 2-second `/state` pollers · **High**
**Files:** `ClassroomRoom.tsx:1292` (`useRoomState(code, 2000)`), `ClassroomRoom.tsx:2184-2217` (a second `setInterval`)

```ts
// RoomInner, line 1292
const { state, refresh } = useRoomState(code, 2000);      // → GET /api/rooms/{code}/state

// ClassroomRoom, line 2186 — same endpoint, same body, 1.5s later
const t = setInterval(async () => {
  const stateRes = await roomFetch(code, '/state');
  ...
  setCanPublishVideo(!!state.me?.canPublishVideo);
  setIsTeacher(!!state.isTeacher);
}, 2000);
```

The outer one exists only because `load()` reads the *initial* state. Once connected, `useRoomState` already supplies `isTeacher` and `canPublishVideo` — `effectiveCanPublish` (line 1324) and `effectiveMuted` (1325) are already derived from `state`. The second poller is pure duplication.

**Impact:** 2× the load on the single hottest endpoint in the app, for zero behavioural gain.

**Fix:** delete the `setInterval` at 2184-2217. `useRoomState` already handles the `ENDED` transition (lines 57-87) and `RoomInner` already calls `onClassEnded()` on `state.status === 'ENDED'` (line 1332-1341).

---

### F-22 · `/state` costs 4–5 Postgres round trips and 6–8 *sequential* Redis round trips · **Critical (perf)**
**File:** `apps/web/src/app/api/rooms/[code]/state/route.ts:9-96`

Per request, in order:

| # | Call | Cost |
|---|---|---|
| 1 | `prisma.room.findUnique({ include: { teacher, participants where status in [WAITING,ADMITTED] } })` | PG (2 queries: main + relation) |
| 2 | `getTeacherSession()` → `prisma.teacher.findUnique` | **PG — pure overhead, the JWT already has the claims** |
| 3 | `getStudentParticipant()` → `participant.findUnique({ include: { room: true } })` | PG |
| 4 | `ensureSampleFresh()` → `redis.get(rotation)` | Redis RTT |
| 4b | (if stale) `rotateVisibleSample` → `room.findUnique` + `participant.findMany(150 rows)` + `hgetall` + `multi` | PG ×2 + Redis ×3 |
| 5 | `getVisibleSample()` → `smembers` **then** `get` | Redis ×2 |
| 6 | `redis.smembers(muted)` | Redis |
| 7 | `redis.smembers(hands)` | Redis |
| 8 | `redis.get(stage)` | Redis |
| 9 | `redis.get(wbWrite)` | Redis |

**4–5 PG queries + 6–8 sequential Redis RTTs per poll.** Steps 5–9 are five independent reads awaited one after another — at 0.3 ms RTT each that is ~1.5 ms of pure latency per request, and they are trivially pipelineable.

At the documented `README.md:211` target of ~150 attendees:
> 150 clients × 1 poll/s (F-21 says 2) × 4.5 PG queries = **~1,350 PG queries/sec** and **~1,050 Redis round trips/sec**, on a 2 GB VPS with `shared_buffers=128MB`, `max_connections=100`, and a Prisma pool of `num_cpus*2+1 ≈ 5`.

This will not hold. Even at 25 students it is uncomfortable.

**Fixes, in order of value:**
1. **Delete the duplicate poller** (F-21) — free 2×.
2. **Pipeline all Redis reads into one `MULTI`** (or `pipeline()`): `smembers(muted)`, `smembers(hands)`, `get(stage)`, `get(wbWrite)`, `get(rotation)` in a single round trip.
3. **Stop doing a DB lookup in `getTeacherSession`.** The JWT already carries `sub`, `email`, `name`. Only re-read on the lazy `permanentCode` backfill path. That removes 1 of 4 PG queries from *every* authenticated route in the app.
4. **Cache the sample read.** `getVisibleSample` is called right after `ensureSampleFresh`, which just wrote it. Return the value from the rotation instead of re-reading.
5. **Back off polling.** 2s is far too aggressive for mute/end propagation. Use a 4–5s base poll plus immediate `refresh()` on the events that matter (the app already does this correctly for admit/mute/hand/stage — the interval is the floor, not the mechanism).
6. **Cache `/state` server-side for ~1s** keyed by room code, so 150 clients polling in the same second collapse to one execution. This single change turns a linear problem into a constant one.

---

### F-23 · `ensureSampleFresh` is a check-then-act race that stampedes on every rotation boundary · **High**
**File:** `apps/web/src/lib/sample.ts:114-127, 64-104`

```ts
const rotatedAt = Number((await redis.get(keys.rotation(roomCode))) || 0);
if (!rotatedAt || Date.now() - rotatedAt > ROTATION_SECONDS * 1000) {
  return rotateVisibleSample(roomCode);   // ← no lock
}
```

`ROTATION_SECONDS` defaults to 8, and the `rotation` key has a TTL of `ROTATION_SECONDS * 3` (line 100). When it expires, **every concurrent client that happens to poll in that window runs a full `rotateVisibleSample`** — each doing a `participant.findMany` of all admitted rows, a `hgetall`, a shuffle, and a `DEL`+`SADD` multi.

Worse, the read of `pinned`/`admitted` (lines 73-95) and the write (97-101) are not atomic, so concurrent rotations race: `pinSpeaker` (which carefully avoids ejecting other sticky speakers, lines 180-190) can have its work clobbered by a rotation that read the pin set a moment earlier. Sticky pins get dropped non-deterministically.

**Impact:** a thundering herd every 8 seconds, each participant doing a full-table read, plus non-deterministic pin loss. At 150 clients this is 10–20 concurrent rotations per tick.

**Fix:** take a lock and have exactly one client rotate.
```ts
const lock = await redis.set(keys.rotateLock(code), '1', 'PX', 3000, 'NX');
if (!lock) return getVisibleSample(roomCode);   // someone else is rotating
```
Better still, **decouple rotation from polling entirely**: a single interval on the teacher's client calls `POST /api/sample/rotate` (which already exists and is already authorized), and `ensureSampleFresh` becomes a pure read that only *extends* a stale window rather than rotating. That removes rotation from the hot request path completely.

---

### F-24 · Whiteboard poll transfers, parses and re-stringifies the full document every 1.5 s per client · **High**
**Files:** `Whiteboard.tsx:335-363`, `apps/web/src/app/api/rooms/[code]/whiteboard/route.ts:41-54`

```ts
const t = setInterval(async () => {
  const res = await roomFetch(code, '/whiteboard');
  ...
  const h = hashSnap(data.snapshot);            // JSON.stringify(entire snapshot)
  if (!h || h === lastPersistedHash.current || h === lastAppliedHash.current) return;
  applySnapshot(data.snapshot);                 // loadSnapshot → replaces the whole store
}, 1500);
```

This runs whenever the whiteboard is on stage, for **every** participant. The change detection happens *after* the full transfer and after a full `JSON.stringify`, so it saves nothing on the expensive parts. And `hashSnap` (`Whiteboard.tsx:126-133`) is a **weak** check anyway — `length + first 160 chars` — so a change deep in a large document is invisible and clients silently diverge.

There is also a live-keyboard path: `applySnapshot` → `loadSnapshot` **replaces the entire tldraw store**, which will fight a student who is mid-stroke.

A 500-shape tldraw document is ~500 KB of JSON. At 150 students: `150 × 0.67/s × 500 KB ≈ 50 MB/s` out of Redis, through Next, into 150 browsers, each doing a `JSON.parse` + `JSON.stringify` + full store replacement every 1.5 seconds. On a 2 GB box this is the single most expensive thing in the app.

**Fix:**
- Gate the poll on the *writer* only, or better, use a monotonic version counter. `GET` returns `{version, snapshot}`; clients compare `version` and only re-parse when it changes:
  ```ts
  if (data.version === versionRef.current) return;   // no transfer of the body at all
  ```
  Store the version in a tiny separate Redis key so the common case transfers ~20 bytes.
- Debounce `persist` more aggressively (400 ms → 2 s for the full snapshot; the LiveKit data channel already carries near-realtime deltas via the `diff` path at `Whiteboard.tsx:442-466`).
- Skip `applySnapshot` while the local editor has an active drawing tool / active pointer.

---

### F-25 · Rotation forces a full camera track re-acquisition on both sides every 8 s · **Medium**
**Files:** `ClassroomRoom.tsx:1129-1196`, `lib/sample.ts:64-104`

When `canPublishVideo` flips, `SelectivePublisher` calls `unpublishTrack` + `track.stop()` and then `createLocalVideoTrack(...)` + `publishTrack`. `createLocalVideoTrack` re-runs `getUserMedia` and initialises a fresh encoder. With F-06 (full reshuffle), ~all 6 slots churn every 8 s.

**Fix:** keep the `MediaStreamTrack` alive and only toggle publication (`setCameraEnabled` / `unpublish`+`republish` the *same* track object) rather than acquiring a new one. Combined with F-06's overlap-preserving rotation, churn drops to ~2 track starts per rotation.

---

### F-26 · LiveKit subscribe/unsubscribe is driven by 1.5 s and 2 s polling loops, not events · **Medium**
**Files:** `ClassroomRoom.tsx:459-493` (teacher cam, 1500 ms), `719-757` (peer cams, 2000 ms)

Both components register the correct LiveKit event handlers (`TrackPublished`, `TrackSubscribed`, `TrackUnsubscribed`, `TrackSubscriptionFailed`, `ParticipantConnected/Disconnected`, `TrackMuted/Unmuted`) **and then also run a redundant interval** on top. The intervals call `setSubscribed(true)` plus a `bump()` that forces a React re-render of the whole float.

`bump` is only there to work around the fact that LiveKit's `setSubscribed` does not itself trigger a re-render of a component that reads `pub.track` directly instead of via `useTracks`. Every 1.5 s the teacher client re-renders `TeacherCameraFloat` and every 2 s `TeacherPeersFloat` (whose `ensure` ends in `setTick(n => n+1)`), invalidating the `peerIds` `useMemo` (line 762) and re-running the shuffle logic on every tick.

**Fix:** subscribe via `useTracks` (which already re-renders on subscription changes) and delete both `setInterval`s plus the `tick`/`stickyVersion` state. If a subscription force is genuinely needed, do it once in a `TrackPublished` handler and rely on `useTracks` for rendering.

---

### F-27 · No resource limits, no log caps, and the scale claim is ~100× beyond the hardware · **High**
**Files:** `docker-compose.yml` (no `mem_limit`/`cpus`/`logging` anywhere), `README.md:211`

Measured idle RSS of the real stack: `web 42→58 MB`, `postgres 37.7→52.2 MB`, `livekit 14.9 MB`, `redis 12.9 MB` ⇒ **~110–140 MB control plane**. With `dockerd` and the OS, ~450–500 MB baseline. **The control plane fits 2 GB comfortably — LiveKit media is the problem.**

`README.md:211` targets "~20 concurrent rooms × ~150 attendees" with a 6-video cap. That is 120 SFU ingress streams and up to 20 × 150 × 7 = **21,000 track subscriptions**. At ~1.5 Mbps and a ~1.5 s jitter buffer, LiveKit holds ~280 KB per subscription ⇒ **≈ 5.9 GB of buffer alone**, plus ~1.3 Gbps of egress. The realistic ceiling on 2 GB / 2 vCPU is **2–3 concurrent rooms of 10–15 students**.

With no limits, exceeding memory means the kernel OOM killer picks by RSS — usually `postgres` — producing a crash/restart loop with a half-written database instead of a clean degradation. Logging is `json-file` with **no `max-size`/`max-file`**, and `infra/livekit.yaml:15` runs at `logging.level: info`, so a 150-participant room logs per-participant events until the disk fills.

**Fix:**
```yaml
x-common: &common
  restart: unless-stopped
  logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }
  security_opt: ["no-new-privileges:true"]
postgres: { mem_limit: 512m }
redis:    { mem_limit: 256m }
web:      { mem_limit: 768m }
livekit:  { mem_limit: 1g, cpus: 1.5 }
```
Add a 1 GB swapfile to the VPS docs and **correct `README.md:211`** to the real per-VPS ceiling, or document LiveKit Cloud / a dedicated SFU host.

---

### F-28 · LiveKit UDP port range cannot support the stated room size · **High**
**Files:** `infra/livekit.yaml:6-7,19`, `README.md:211`

```yaml
port_range_start: 50000
port_range_end:   50100     # 101 ports
room: { max_participants: 200 }
```

LiveKit allocates **one UDP port per participant per SFU**. `max_participants: 200` needs ~200 ports; at 101, any class over ~100 admitted participants silently gets no media for the overflow. This flatly contradicts the documented 150-attendee target.

**Fix:** `port_range_end: 50400` (or higher) and firewall the matching range. Also set `room.max_participants` to a value the box can actually serve (≈40), so the limit is enforced rather than discovered.

---

### F-29 · Postgres and Redis are un-tuned for a 2 GB VM · **Medium**
**File:** `docker-compose.yml:9-23` (no `command:`)

Live defaults on the running container: `shared_buffers 128MB`, `effective_cache_size 512MB`, `max_connections 100`, `work_mem 4MB`, **`max_wal_size 1GB`**, `/dev/shm` 64 MB.

On a 2 GB box `effective_cache_size=512MB` makes the planner badly under-use indexes (see F-30), and `max_wal_size=1GB` can consume half a small disk during a bulk write. `DATABASE_URL` also has no `connection_limit=`, so Prisma defaults to `num_cpus*2+1 ≈ 5` — a queue of hundreds under F-22's load.

**Fix:**
```yaml
postgres:
  command: ["postgres","-c","listen_addresses=127.0.0.1","-c","shared_buffers=256MB",
            "-c","effective_cache_size=1536MB","-c","maintenance_work_mem=128MB",
            "-c","max_wal_size=512MB","-c","max_connections=50"]
  shm_size: 256mb
# DATABASE_URL=postgresql://...?schema=public&connection_limit=10&pool_timeout=20
```

---

### F-30 · Postgres query patterns and indexes · **Medium**

**N+1 in chat:** `messages/route.ts:101-106` loads `take: 500` messages **with both relations included**, for **every student**, then filters the visibility in JavaScript (108-116). A student pulls 500 rows (including the teacher's DMs to other students) out of the DB only to discard most of them server-side. This is also a data-minimisation smell — the rows leave Postgres even though the response does not.

**Indexes are adequate but not optimal.** `@@index([roomId, createdAt])` on `Message` (schema.prisma:95) is unused as a *composite covering* index — the query is `roomId = ? ORDER BY createdAt ASC LIMIT 500`, which the index does serve as an index scan, but every row then needs the two relation lookups. `Participant` has `@@index([roomId, status])` (schema.prisma:73) which correctly serves `rotateVisibleSample` and `state`, but `@@index([sessionToken])` at line 74 is **redundant** — `sessionToken` is already `@unique` (line 65), which creates the index.

`rotateVisibleSample` (`sample.ts:73-76`) runs `participant.findMany({ where: { roomId, role: 'STUDENT', status: 'ADMITTED' }, select: { livekitIdentity } })` — a full scan of the admitted set, on *every rotation*, of which there are many per tick under F-23. At 150 students that is 150 rows read ~15× per second during a stampede.

**Fix:**
- Chat: move visibility into the `where` clause so the DB does the filtering —
  ```ts
  where: { roomId, OR: [{ scope: 'BROADCAST' }, { scope: 'TEACHER', senderParticipantId: id }, { scope: 'DIRECT', recipientParticipantId: id }] }
  ```
  plus `orderBy: { createdAt: 'desc' }` (F-09). Teachers keep the unfiltered query.
- Drop the redundant `@@index([sessionToken])`.
- Add `@@index([roomId, role, status])` to `Participant` to make `rotateVisibleSample` an index-only scan.
- Cache the admitted-identity list in Redis (it only changes on admit/leave/mute, all of which are already write paths) and have `rotateVisibleSample` read it instead of hitting Postgres.

---

### F-31 · Next.js bundle and Docker image size · **High**
**Files:** `apps/web/Dockerfile:7,20,34,38`, `docker-compose.yml:49-56`

The client bundle is fine: `/app/.next/standalone` + `/app/.next/static` is ~3.0 MB total, largest chunks 992 KB (tldraw, correctly `dynamic()`-imported at `Whiteboard.tsx:21`), 549 KB (livekit-client), 173 KB — and `Cache-Control: public, max-age=31536000, immutable` is correctly applied to `/_next/static/*`.

The **image is 1.41 GB**, of which ~1.16 GB is avoidable:

| Size | Layer | Problem |
|---|---|---|
| 583 MB | `Dockerfile:38` `chown -R nextjs:nodejs /app` | Full copy-up of 583 MB purely to change ownership |
| 578 MB | `Dockerfile:34` `COPY --from=builder /app/node_modules` | **All** devDependencies (typescript, tailwind, prisma CLI, eslint, all `@types`) |
| 36.7 MB | `Dockerfile:35` standalone | actual app |
| 10.3 MB | `Dockerfile:28` apt | |

Two independent bugs: (a) compose never passes `--omit=dev`, and (34) copies the *entire* builder `node_modules` before the standalone tracer's minimal tree is merged on top; (b) `chown -R` is a copy-up.

`Dockerfile:7` also uses `npm install --legacy-peer-deps` rather than `npm ci`, despite `package-lock.json` being committed and in sync, and has **no cache mounts** for `/root/.npm` or `/app/.next/cache` — so every clean build re-downloads 630 MB and does a full webpack pass.

**Fix:**
```dockerfile
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static  ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public        ./public
COPY --from=builder --chown=nextjs:nodejs /app/prisma        ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=deps    /app/node_modules/prisma /app/node_modules/prisma
COPY --from=deps    /app/node_modules/@prisma /app/node_modules/@prisma
```
plus `RUN --mount=type=cache,target=/root/.npm npm ci --legacy-peer-deps --no-audit --no-fund`. Target: **~250 MB**.

Also `Dockerfile:20` bakes a real-looking Postgres password into a build layer (visible in `docker history`), for a host (`postgres`) that doesn't even exist in this host-networked stack.

---

### F-32 · `NEXT_PUBLIC_*` build args are dead config; the real values are runtime · **Medium**
**Files:** `apps/web/Dockerfile:14-17`, `docker-compose.yml:53-56,67-68`

Every `NEXT_PUBLIC_` read in the tree is in `apps/web/src/lib/url.ts:32,39,73`, and the only importer is the **server** route `api/rooms/create/route.ts`. No `'use client'` module reads `process.env.NEXT_PUBLIC_*` — the browser's LiveKit URL arrives in the `/token` response (`token/route.ts:65`).

Consequences:
- The `ARG`/`ENV` pair and `compose` `build.args` block have **no effect on any output**.
- The runtime `environment:` entries (compose:67-68) are the ones that matter, so `NEXT_PUBLIC_LIVEKIT_URL` can change with a plain `docker compose up -d web` — **no rebuild needed**, despite `package.json:6` and every doc step passing `--build` and rebuilding 1.4 GB for nothing.
- The trap: the moment anyone reads a `NEXT_PUBLIC_*` var in a client component, it *is* frozen at build time and the runtime line becomes a silent no-op.

**Fix:** delete the `ARG`/`ENV` pair and the `build.args` block; change `package.json:6` to `docker compose up -d`; document in `.env.example` that these are server-side runtime vars.

---

### F-33 · Redis has AOF with no `maxmemory` and most `room:*` keys never expire · **Medium**
**Files:** `docker-compose.yml:29`, `apps/web/src/lib/redis.ts:29-46`

`--appendonly yes` with `maxmemory 0` / `noeviction`. Only `room:{code}:whiteboard` gets a TTL (`whiteboard/route.ts:73`, `EX 21600`); `waiting`, `admitted`, `visible`, `muted`, `rotation`, `stage`, `wb-write`, `pinned-speakers`, `hands` (`redis.ts:30-45`) have **none**. Every room ever created leaks keys forever, and `ensureTeacherPermanentCode` means codes are permanent — so the leak is monotonic for the life of the deployment.

On a 2 GB VPS, AOF + RDB means periodic `BGSAVE`/`BGREWRITEAOF` forks (copy-on-write), and with no ceiling writes fail opaquely (`OOM command not allowed`) or the host is OOM-killed first.

**Fix:**
```yaml
command: ["redis-server","--appendonly","yes","--appendfsync","everysec",
          "--maxmemory","192mb","--maxmemory-policy","allkeys-lru",
          "--bind","127.0.0.1","--save","900 1"]
```
and give every `room:*` key an expiry, or delete the room's key set in the `end` route (it already deletes 10 of 11 — `pinRate:*` keys are missed, though those self-expire via `PX 2000`).

---

# 3. Networking / realtime

### F-34 · No TURN, and the port range cannot serve the claimed room size · **High**
**Files:** `infra/livekit.yaml:1-19`, `README.md:224`, `docs/DEPLOY-VPS.md:128-130`

There is no `turn:` block anywhere, and the app has no `iceServers` plumbing to point a client at one. The README calls TURN "not built in", which is honest, but the consequence is unstated: **a student behind a symmetric NAT (many corporate/school networks and most mobile carriers) simply gets no video, with no diagnostic and no fallback.**

Compounding it: `port_range_start/end = 50000-50100` (101 ports) versus `max_participants: 200` (F-28), and `use_external_ip: false` is the **committed default** (`livekit.yaml:9`). The auto-detect path depends on outbound STUN, which is blocked on many VPS networks — the symptom being media that connects on some networks and never on others. `scripts/configure-public-ip.sh` does set `LIVEKIT_NODE_IP`, but nothing *enforces* that it was run.

**Fix:**
- Pin `rtc.node_ip` on any public deploy and fail startup if neither `node_ip` nor a working `use_external_ip` is set.
- Either add `turn: { domain, auth_secret, ttl }` (coturn) or publish an explicit supported-NAT matrix and have `/api/health` report `turn: "unavailable"` so it is visible rather than silent.
- Align `port_range_end` with `max_participants` (F-28).

---

### F-35 · WSS/HTTPS config is correct, but the "localhost vs public IP" derivation has sharp edges · **Medium**
**Files:** `apps/web/src/lib/url.ts:23-93`, `apps/web/src/app/api/rooms/[code]/token/route.ts:65`

`resolveAppUrl` prefers a non-loopback `Origin`, then `x-forwarded-host`/`host`. `resolvePublicLiveKitUrl` prefers a non-loopback `NEXT_PUBLIC_LIVEKIT_URL`, else derives `ws(s)://host:7880`. This is a genuinely nice operator convenience — hitting `http://PUBLIC_IP:3000` produces correct shareable links without reconfiguration.

Sharp edges:
- `url.ts:55` trusts `x-forwarded-host` **unconditionally**. Under `network_mode: host` with no trusted-proxy boundary, a client can send `X-Forwarded-Host: evil.example` and have that value baked into the `joinUrl`/`teacherUrl` the teacher copies and distributes (`rooms/create/route.ts:36-37`). It only reaches the teacher who is already in the room, so impact is limited to a phishing link the teacher is tricked into sharing — but it should not be attacker-controlled. Caddy sets `X-Forwarded-Host` itself; strip the client-supplied value or gate on a known-proxy set.
- `url.ts:84` hardcodes port `7880` via `LIVEKIT_PUBLIC_PORT`, ignoring a non-default LiveKit port. Fine today; brittle.
- `isLoopbackHost` (`url.ts:23-26`) does not treat `localhost.localdomain`, `0:0:0:0:0:0:0:1`, or bracketed IPv6 as loopback, so an IPv6 localhost falls through to the env var path. Minor.

**Fix:** only honour `x-forwarded-*` when `TRUST_PROXY=1`; otherwise use `Host` and `APP_URL`.

---

### F-36 · Cookie security: `SameSite=Lax` is adequate, `Secure` is correct, but the defaults are HTTP · **Medium**
**Files:** `apps/web/src/lib/auth.ts:32-124`, `apps/web/src/lib/url.ts:29-36`, `docker-compose.yml:69`

- `httpOnly: true` on all four cookies (`classroom_teacher`, `classroom_student`, `classroom_act_as`) — correct.
- `sameSite: 'lax'` — **adequate**. Every state-changing route is a `POST`/`PATCH`/`DELETE`, and Lax does not send cookies on cross-site non-navigational requests, so CSRF via a simple form is blocked. There is no state-changing `GET` in the app. Worth stating explicitly since there's no CSRF token anywhere.
- `secure: cookieSecureFlag()` (`url.ts:29-36`) derives from `COOKIE_SECURE` then `APP_URL` scheme — the logic is right.
- **The problem is the deployment default.** `docker-compose.yml:69` sets `COOKIE_SECURE: ${COOKIE_SECURE:-false}` and `README.md:107-113` documents "Open `http://PUBLIC_IP:3000`" as a supported production path. Over plain HTTP, the teacher session JWT is a 7-day bearer token in cleartext on every request. `docs/DEPLOY-VPS.md` does recommend Caddy, but the bare-HTTP path is presented as a first-class option.
- **No `next.config.mjs` security headers and no Caddy headers** (F-39). Specifically missing `Permissions-Policy: camera=(self), microphone=(self), display-capture=(self)` — meaningful for a WebRTC app, and its absence is the only thing preventing an embedding page from requesting the camera.

**Fix:** make HTTPS the documented default; set `COOKIE_SECURE=true` unconditionally in the `tls` compose profile; add the `Permissions-Policy` header.

---

### F-37 · `ROOMCODE`-only authz is by design, but the enumeration oracle should be closed · **Medium**
**Files:** `apps/web/src/app/api/rooms/[code]/join/route.ts`, `state/route.ts:35`, `sample.ts:5`, `codes.ts:3-4`

The room code is the only credential a student needs — inherent to the "no student accounts" design and correctly documented. The generator is sound: 32 symbols (`codes.ts:3`, Crockford-ish alphabet) × 6 = **~1.07 B** combinations, which is not brute-forceable at any realistic rate.

Two things weaken it:
1. **Existence oracle.** `state` returns `404` for a nonexistent code and `200` with `status`/`teacherName` for a real one. Unthrottled, that turns 1.07 B into a feasible enumeration target for a patient attacker, and it also leaks the teacher's display name for any code found.
2. **Legacy codes are 12× weaker.** `migration.sql:20` derives codes via `UPPER(SUBSTRING(REGEXP_REPLACE(md5(id || email),'[01]','X','g'), 1, 6))`. After stripping `0`/`1` and upper-casing, the alphabet is `[2-9A-F]` = 16 symbols ⇒ **16.7 M** combinations — 64× fewer, and with a `LEFT(code,5) || char` collision path. Any teacher created before that migration (moot only because the migration currently cannot run — F-38) has a code an order of magnitude easier to guess.

**Fix:** return `200` with a neutral `{ exists: false }` from `state` for unknown codes; re-issue `permanentCode` for rows the migration touched, from the 32-symbol generator.

---

### F-38 · Migration 3 is invalid SQL and fails on a clean database · **Critical**
**File:** `apps/web/prisma/migrations/20260927153000_teacher_permanent_code/migration.sql:30`

```sql
SET "permanentCode" = LEFT(d."permanentCode", 5) || SUBSTRING('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', d.rn, 1)
```

`d.rn` is `bigint` (from `ROW_NUMBER()`) and the string literal is `unknown`. PostgreSQL has no `substring(text, bigint, int)` ⇒ parse-time error `42883: function substring(unknown, bigint, integer) does not exist`, **failing even on an empty table.**

Verified by running the real compose stack against a clean DB:
```
Applying migration `20260927153000_teacher_permanent_code`
Error: P3018 … 42883: function substring(unknown, bigint, integer) does not exist
```
and afterwards:
```
20240925000000_init                   | finished=t
20260925160000_messages               | finished=t
20260927153000_teacher_permanent_code | finished=f   ← poisoned
```

**Three consequences:**
1. The production schema is produced by `prisma db push`, not by migrations. `migrate deploy`, `migrate dev`, `migrate reset` and `migrate diff --from-migrations` all now refuse to run — **no developer can ever produce a correct next migration.**
2. Every subsequent boot hits `P3009` ("found failed migrations") and re-falls through to `db push`.
3. Live DB now disagrees with the committed history: `information_schema` reports `Room.maxVisibleVideos` default **6**, while `20240925000000_init/migration.sql:28` says **10**. The history can never be replayed to reproduce the running database.

**Fix:**
```sql
SET "permanentCode" = LEFT(d."permanentCode", 5)
  || SUBSTRING('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', d.rn::int, 1)
```
Then repair: `prisma migrate resolve --rolled-back 20260927153000_teacher_permanent_code`, verify, re-apply. Add a CI drift check so this class of error cannot merge again:
```bash
prisma migrate diff --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$SHADOW" --exit-code
```

---

### F-39 · `|| prisma db push --accept-data-loss` is an unauthenticated data-loss path at every boot · **Critical**
**File:** `apps/web/docker-entrypoint.sh:32`

```sh
npx prisma migrate deploy || npx prisma db push --accept-data-loss
```

The `||` fires on **any** nonzero exit — wrong password, DNS, a transient network blip, the `P3009` from F-38. `--accept-data-loss` is precisely the flag authorising table/column drops. `set -e` is defeated by design, there is no backup step and no confirmation. And per F-38, this is the **normal** path on a fresh install, not an edge case.

**Fix:** fail closed, and move migrations out of the web container entirely.
```sh
if ! npx prisma migrate deploy; then
  echo "[classroom] migration failed — refusing to start; DB left untouched" >&2
  echo "[classroom] fix the migration, or: prisma migrate resolve --applied/--rolled-back <name>" >&2
  exit 1
fi
```
```yaml
migrate:
  build: { context: ./apps/web }
  command: ["npm","run","prisma:migrate"]
  depends_on: { postgres: { condition: service_healthy } }
  restart: "no"
web:
  depends_on: { migrate: { condition: service_completed_successfully } }
```

---

### F-40 · Redis failure mode: `ensureRedis()` throws on `status === 'end'`, and every route 500s · **Medium**
**File:** `apps/web/src/lib/redis.ts:17-26`

```ts
export async function ensureRedis() {
  if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
  return redis;
}
```

`ioredis` cannot `connect()` from `end` — it throws `Error: Redis is already connecting/connected` or a "Stream isn't writeable" error. The `end` branch is simply wrong; a client in `end` needs to be **replaced**, not reconnected. Combined with `maxRetriesPerRequest: 3` and no `retryStrategy` tuning, a Redis restart makes **every** API route in the app throw a 500 (each wraps it in `jsonError(..., 500)`) until the process is restarted. `/api/health` correctly reports `degraded`, but nothing self-heals.

`ensureRedis()` is also called 4× inside a *single* `/state` request (`state/route.ts:72,73,74` + implicit) — harmless but sloppy.

**Fix:**
```ts
let client = globalForRedis.redis;
async function get() {
  if (!client || client.status === 'end') {
    client = createRedis();
    globalForRedis.redis = client;
  }
  if (client.status === 'wait') await client.connect();
  return client;
}
```
with `retryStrategy: (times) => Math.min(times * 200, 5000)`. And drop the redundant `ensureRedis()` calls.

---

### F-41 · Room state is polled, never pushed · **Medium**
**Files:** `useRoomState.ts:101`, `ClassroomRoom.tsx:2186`, `Chat.tsx:149`, `Whiteboard.tsx:336`

There is **no Redis pub/sub, no SSE, and no LiveKit data-channel transport for room state.** Everything is HTTP polling at 1.5–2 s. LiveKit *is* connected and could carry state as a reliable data message (the app already does exactly this for chat and whiteboard diffs), which would make mute/stage/hand/end propagation sub-second and near-free.

**Impact:** this is the root cause of the latency in every teacher action (up to 2 s for a mute to appear) and the load in F-22.

**Fix:** publish room-state deltas to a `state` topic over LiveKit (as `Chat.tsx:184-198` and `Whiteboard.tsx:208-240` already do), and keep the HTTP poll as a slow fallback (15 s) rather than the primary channel. This single change would eliminate most of F-21, F-22 and F-24.

---

### F-42 · No token-refresh or reconnect recovery on the LiveKit client · **High**
**File:** `ClassroomRoom.tsx:2250-2270`

```tsx
<LiveKitRoom token={tokenData.token} serverUrl={tokenData.url} connect
  video={false} audio={false}
  onError={(e) => console.error('LiveKit', e)}>
```

There is no `onReconnecting` / `onReconnected` / `onDisconnected` handler. LiveKit's built-in auto-reconnect handles transient network flaps internally, but:
- when the token **expires** (6h, F-03) the client is dropped with no path to re-mint;
- on a permanent disconnect the UI stays on the last rendered frame with no error surfaced to the user — `onError` only writes to the console.

**Fix:** add `onDisconnected` → `load()` to re-mint, and surface a reconnect banner on `onReconnecting`.

---

### F-43 · Redis is not used for presence; participant truth is split across Postgres and Redis · **Low**
**Files:** `lib/redis.ts:30-45`, `state/route.ts:85-86`

`room:{code}:admitted` is written by `admit/route.ts:56` but **never read by any code path** — `state` derives the roster from Postgres instead. Similarly `keys.waiting` is written by `join`/`admit` but the waiting list comes from Postgres. The Redis sets are effectively write-only duplicates that can silently drift.

**Impact:** low correctness risk today, but it's dead state that costs a `DEL`+`SADD` of up to 150 members on every admit, and it misleads the next reader into thinking presence is Redis-backed.

**Fix:** either delete the unused sets or make them authoritative. Given `state` already loads all participants from Postgres in one indexed query, deleting is the honest answer.

---

# 4. Security

Covered above in detail. Consolidated severity:

| ID | Issue | Severity |
|---|---|---|
| F-20 | LiveKit API secret in git history **and still deployed** | **Critical** |
| F-38/39 | Broken migration + `db push --accept-data-loss` at every boot | **Critical** |
| F-01 | Video sampling unenforced server-side (core privacy claim) | **Critical** |
| F-13 | Unbounded unvalidated whiteboard `PUT` → Redis OOM | **High** |
| F-11 | No rate limits on login (bcrypt DoS) / register / join / chat | **High** |
| F-05 | Chat history leaks across class sessions | **High** |
| — | **Postgres listens on `0.0.0.0:5432`** with default password `classroom_dev_password`; Redis correctly pinned to `127.0.0.1` (`compose:29`), Postgres is not | **Critical** |
| — | `.env.example:31,43` ship `replace-with-long-random-secret` / `change-me-...` and **no script generates either**; `auth.ts:10-14` only throws if *unset*, never if it's the documented placeholder. The documented VPS path (`README.md:107-113`) therefore yields publicly-forgeable 7-day teacher JWTs. | **Critical** |
| F-37 | Room-code enumeration oracle; legacy codes 16-symbol alphabet | Medium |
| F-36 | `COOKIE_SECURE=false` on the documented bare-HTTP path; no `Permissions-Policy`; no security headers anywhere | Medium |
| F-14 | `?as=student` header is a downgrade-only identity switch (not an escalation) | Low |
| F-19 | **No XSS vectors** — no `dangerouslySetInnerHTML`, no `innerHTML`, no `eval`. Chat is safely escaped by JSX; `Avatar` renders text. | ✅ |

**Postgres exposure detail** (verified on the running stack): the official image forces `listen_addresses='*'` and `compose` adds no override, so `tcp 0.0.0.0:5432 LISTEN` while `tcp 127.0.0.1:6379 LISTEN`. `docs/DEPLOY-VPS.md:11` says "Postgres/Redis stay reachable on 127.0.0.1" and "do not open 5432" — the docs describe a state the config does not produce, and the `ufw` example at `DEPLOY-VPS.md:36-43` only ever *adds* rules.

**Fix:** add `command: ["postgres","-c","listen_addresses=127.0.0.1", ...]` and remove the `:-classroom_dev_password` fallbacks so a missing `.env` fails loudly instead of booting a known-password database.

**Secrets-generation fix:**
```sh
# scripts/sync-livekit-keys.sh, before sourcing
touch "$ROOT/.env"
grep -q '^LIVEKIT_API_SECRET=' "$ROOT/.env" || echo "LIVEKIT_API_SECRET=$(openssl rand -hex 32)" >> "$ROOT/.env"
grep -q '^NEXTAUTH_SECRET='    "$ROOT/.env" || echo "NEXTAUTH_SECRET=$(openssl rand -hex 32)"    >> "$ROOT/.env"
grep -q '^POSTGRES_PASSWORD='  "$ROOT/.env" || echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"  >> "$ROOT/.env"
```
and in `docker-entrypoint.sh`, refuse to boot on a placeholder value.

---

# 5. Reliability / ops

### F-44 · The runner stage has no `CMD` and the entrypoint ignores all arguments · **High**
**Files:** `apps/web/Dockerfile:45`, `apps/web/docker-entrypoint.sh:34`

`ENTRYPOINT ["/docker-entrypoint.sh"]` with **no `CMD`**, so the base image's `CMD ["node"]` is inherited, and the entrypoint never does `exec "$@"`. Verified on the built image: `cmd=[]`, `docker history: CMD ["node"]`.

**Impact:** `docker compose run --rm web bash` starts the **production server**. `docker compose run --rm web npx prisma migrate resolve --rolled-back …` — the exact command needed to repair F-38 — is silently ignored. Any `command:` override is ignored.

**Fix:**
```dockerfile
CMD ["node", "server.js"]
```
```sh
if [ "$#" -gt 0 ]; then exec "$@"; fi
exec node server.js
```

### F-45 · Migrations run as PID 1 `sh` with no signal forwarding · **High**
**Files:** `apps/web/docker-entrypoint.sh:1-34`, `docker-compose.yml:57`

`set -e` only — no `set -u`, no `trap`, no `tini`/`--init`. From container start until line 34, **PID 1 is `/bin/sh`, which does not forward `SIGTERM`**. `restart: unless-stopped` is set but there is no `stop_grace_period`, so Docker waits the default 10 s then `SIGKILL`s — leaving a **half-applied migration** and exactly the `finished=f` row observed in F-38. Under `restart: unless-stopped` that partial state is re-entered on every boot, permanently.

(Once `exec node server.js` runs, PID 1 is `next-server`, so the server itself is fine — the exposure window is the migrate phase.)

**Fix:** add `stop_grace_period: 45s` to the `web` service, add `trap 'exit 143' TERM INT` to the entrypoint, and prefer the dedicated `migrate` service (F-39) so the web container never mutates schema at boot.

### F-46 · No LiveKit healthcheck, and `/api/health` never probes LiveKit · **Medium**
**Files:** `docker-compose.yml:45-47,81-82`, `apps/web/src/app/api/health/route.ts:30`

LiveKit has no `healthcheck:` and `web` waits on `condition: service_started` — "the process was launched". Meanwhile:

```ts
checks.livekit = process.env.LIVEKIT_API_KEY ? 'configured' : 'missing';
```

— it only checks that an env var exists. It never opens a socket and never validates that the app's key/secret actually **match** the server's. A LiveKit container crash-looping on a bad YAML leaves the app reporting `"status":"healthy"`, leaves Caddy up proxying to nothing, and makes `docker compose --profile tls up -d` report success. A key mismatch surfaces as an opaque 500 on `/token`.

**Fix:** the `livekit-server` image does contain `wget`, so:
```yaml
livekit:
  healthcheck: { test: ["CMD","wget","-qO-","http://127.0.0.1:7880/"], interval: 10s, timeout: 3s, retries: 5, start_period: 10s }
web:
  depends_on: { livekit: { condition: service_healthy } }
```
and have `/api/health` do a real `RoomServiceClient.listRooms([])` probe.

### F-47 · Unhealthy containers are never restarted; Caddy is permanently gated on `web` health · **Medium**
**Files:** `docker-compose.yml:83-88,102-104`, `health/route.ts:42`

`/api/health` returns **503** when Postgres or Redis is unreachable. The compose healthcheck uses `wget -qO-`, which exits nonzero on 503, so a 10-second Redis hiccup marks `web` unhealthy. Docker's `restart:` policy **only acts on process exit, not on health** — so `web` keeps serving (degraded) and is never restarted, while `caddy` (`depends_on: … condition: service_healthy`) refuses to start. In the other direction, if `web` takes longer than `start_period: 45s` + 18×10 s on first boot, `--profile tls up -d` completes **without Caddy and never retries it**.

**Fix:** add `autoheal`; make Caddy resilient (`condition: service_started` + `restart: true`, or drop the dependency and let it return 502 until the app is up).

### F-48 · `env_file: [.env]` means a missing `.env` takes the entire stack down · **Medium**
**File:** `docker-compose.yml:59-60`

`env_file` is validated at Compose **config-parse** time, so a missing or renamed `.env` aborts the whole command — nothing starts, not even `postgres`/`redis`. Verified:
```
$ mv .env .env.moved && docker compose config
env file /workspace/classroom/.env not found: stat …: no such file or directory
```
`README.md:71` says `cp -n .env.example .env  # only if you need a fresh copy`, so a fresh clone that skips it has a stack that will not come up — and since `restart: unless-stopped` does not apply to a container that was never created, the VPS is simply down.

**Fix:** `- path: .env / required: false` (Compose ≥ 2.24), or drop `env_file` entirely and enumerate every var under `environment:` (the list at `compose:61-75` is already nearly complete).

### F-49 · Env precedence silently discards `DATABASE_URL` from `.env` · **Medium**
**File:** `docker-compose.yml:59-68`

`environment:` beats `env_file:`, and line 62 **rebuilds** the connection string from three other variables:
```yaml
DATABASE_URL: postgresql://${POSTGRES_USER:-classroom}:${POSTGRES_PASSWORD:-classroom_dev_password}@127.0.0.1:5432/${POSTGRES_DB:-classroom}
```
So the documented `DATABASE_URL` at `.env.example:26` and `README.md:170` is **decorative** — an operator pointing at a managed Postgres, a socket, or a different port gets it silently overwritten, with a confusing connection error as the only symptom. The same pattern silently overrides `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_LIVEKIT_URL` and `COOKIE_SECURE`.

**Fix:** pick one source of truth. Use `env_file` alone (which also fixes F-48) and delete the duplicated `DATABASE_URL` line from `.env.example`.

### F-50 · `network_mode: host` on all five services · **Medium**
**File:** `docker-compose.yml:12,28,41,58,97`; acknowledged at `docs/DEPLOY-CADDY.md:104`

- **No horizontal scaling.** All services share the host netns, so `--scale web=2` is a port collision on `:3000`. There is no way to run two web replicas.
- **Ports can't be restricted per-service.** `DEPLOY-CADDY.md:104` admits the app "still listens on `0.0.0.0:3000`" and defers to the firewall. Combined with the Postgres exposure, one firewall misconfiguration exposes the app, the DB, and LiveKit's admin API at once.
- **SSRF → cloud metadata.** With host networking, any request-forgery bug can reach `http://169.254.169.254/latest/meta-data/iam/security-credentials/` and read instance IAM credentials. Bridge networking isolates this.
- `ports:` is silently meaningless under host mode — a common source of confusion.

**Fix:** bridge-network `postgres`, `redis` and `web` with explicit `ports: 127.0.0.1:3000:3000`; keep `network_mode: host` only for `livekit` and `caddy`, where public-IP UDP genuinely requires it.

### F-51 · `sync-livekit-keys.sh` writes secrets into YAML unquoted, non-atomically · **Medium**
**File:** `scripts/sync-livekit-keys.sh:5-8,25-44`

Line 37 is `  ${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}` inside an **unquoted** heredoc. Reproduced:
```
$ LIVEKIT_API_SECRET=$ecret:… ./sync-livekit-keys.sh
.env: line 2: ecret: unbound variable          # any '$' in the secret aborts the deploy

$ LIVEKIT_API_SECRET=*star … && ./sync-livekit-keys.sh
  devkey: *star
$ livekit-server --config /etc/livekit.yaml
could not parse config: yaml: unknown anchor 'star' referenced   # crash-loop
```
Also: `source "$ROOT/.env"` executes `.env` as shell; the file is rewritten in place (no temp+`mv`), so an interrupted write leaves a truncated YAML that LiveKit refuses to parse; and there is **no key generation at all** despite `README.md:162` documenting the keys as "generated".

**Fix:** generate the keypair if absent; emit the values via `json.dumps` (valid quoted YAML for any byte content) or `yq`; write to a temp file and `mv` atomically; add a post-write config parse check. Use `install -m 600` — `.env` and `infra/livekit.yaml` are currently mode **0644** (world-readable).

### F-52 · Committed `infra/Caddyfile` targets `example.com`; no security headers; buffers Next streaming · **Medium**
**File:** `infra/Caddyfile:12-24`, `apps/web/next.config.mjs:15-30`

The tracked file is a placeholder for `example.com` / `livekit.example.com`. It **passes `caddy validate`**, so a user who runs `docker compose --profile tls up -d` without first running `configure-domain-tls.sh` gets a container that starts cleanly and then crash-loops / burns Let's Encrypt rate limit on an IANA-reserved, non-resolvable name.

Missing from both site blocks: `Strict-Transport-Security` (Caddy deliberately omits it), `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, and — for this app specifically — `Permissions-Policy: camera=(self), microphone=(self), display-capture=(self)`. `next.config.mjs` has **no** security headers either, and `X-Powered-By: Next.js` is present (verified on the running stack). `serverActions.bodySizeLimit` there is dead config (no `"use server"` anywhere).

`reverse_proxy 127.0.0.1:3000` has no `flush_interval`, so Caddy buffers Next's RSC/Suspense streaming HTML into bursts; combined with `next.config.mjs:20` forcing `no-store` on every document, each navigation is a buffered full round trip.

**Fix:** ship `infra/Caddyfile.example` and gitignore the real one (same treatment as F-20); add a global `header` block; add `flush_interval -1` to the proxy; add `poweredByHeader: false` and the security headers to `next.config.mjs`; delete the dead `serverActions`/`canvas` config.

### F-53 · No backup, no restore path, no logging discipline · **Medium**
**Files:** `docker-compose.yml:106-110`, `docs/DEPLOY-VPS.md:132-138`

`postgres_data` is the only copy of teachers, rooms, participants and **all chat history**. `DEPLOY-VPS.md:136-137` documents `docker compose down -v` as a routine "wipe" step with **no backup step anywhere in the repo**. With F-39 running a data-loss-capable `db push` on every boot, there is no recovery path. There is also no structured logging, no request IDs, and `console.warn`/`console.error` throughout the app with no log level control.

**Fix:** add `scripts/backup.sh` (`pg_dump -Fc` + rclone to off-site) with a systemd timer, document a restore drill, and move to structured JSON logs with per-request correlation IDs.

### F-54 · Entrypoint's Postgres probe mis-parses credentials and IPv6 · **Low**
**File:** `apps/web/docker-entrypoint.sh:7-9`

```js
const m = url.match(/@([^:/]+):(\d+)/);
```

A password containing `@` makes `[^:/]+` swallow it, so the probe targets host `ss@127.0.0.1`, never connects, and the container exits 1 after ~3 minutes into a restart loop. IPv6 (`[::1]:5432`) and URL-encoded credentials also fail, and the fallback silently probes the wrong host. The loop also waits up to 180 s, longer than compose's 45 s `start_period` + retries, and tests only TCP reachability, not auth readiness.

**Fix:** `const u = new URL(url); const host = u.hostname; const port = Number(u.port || 5432);` — Node parses all of these correctly. Then drop the loop entirely in favour of the `migrate` service (F-39) plus compose's `service_healthy`.

### F-55 · `next@14.2.18` is below 14.2.25 (CVE-2025-29927) · **Medium**
**File:** `apps/web/package.json:26`

`next` is pinned exactly at `14.2.18`, below `14.2.25`. That range contains CVE-2025-29927 (CVSS 9.1, `x-middleware-subrequest` authorization bypass).

**Not currently exploitable** — I confirmed there is **no `middleware.ts` anywhere in the tree**, so the vulnerable code path is unreachable. But the pin must not sit below the fix, and a future `middleware.ts` (route protection, geo-blocking, a CSP) would silently become a full authz bypass.

Also: `next lint` (line 10) is deprecated in 14.2 and removed in 15; there is **no `typecheck` script**; no `engines` field or `.nvmrc`; the base image is pinned by mutable tag across three stages (`Dockerfile:3,9,24`); and `@tldraw/tldraw ^2.4.6` and `@livekit/components-react ^2.7.0` are ~2 years stale against a `v1.12.0` server.

**Fix:** bump `next` to ≥14.2.25 (ideally a supported 15.x), add `"typecheck": "tsc --noEmit"`, add `engines`, and pin the base image by digest.

### F-56 · `/api/health` is public, does real work per probe, and leaks config · **Low**
**File:** `apps/web/src/app/api/health/route.ts:8-43`, `docker-compose.yml:83-88`

Unauthenticated on `0.0.0.0:3000`; every probe (every 10 s) runs `SELECT 1` + a Redis `PING` and returns `maxVisibleStudentVideos`, `hardMaxVisibleStudentVideos` and `sampleRotationSeconds` — ~8,600 authenticated DB round trips/day/container. It also can't simply be removed, since Caddy and `npm run health` depend on it.

**Fix:** return `{status, checks}` only; add a no-I/O `/api/live` for liveness; gate the config echo behind an internal token.

---

# 6. Code quality

### F-57 · Zero tests, zero CI · **High**
**Files:** `apps/web/package.json:5-14`, `package.json:4-10`, no `.github/`

There is **no test runner, no test files, and no CI anywhere in the repository.** The only verification is two hand-written markdown checklists (`docs/VERIFY.md`, `docs/E2E_CHECKLIST.md`) that must be executed manually by a human with two browsers.

This is why F-38 shipped: a three-line `prisma migrate diff` CI check would have caught a parse error in a migration before it ever reached a database. It is also why the authz matrix in §4 is unpoliced.

**Fix, in priority order — these are the tests that would have caught the real bugs:**
1. `prisma migrate diff --from-migrations --to-schema-datamodel --exit-code` in CI (catches F-38).
2. A route-handler authz matrix test: for every `api/rooms/[code]/*` route, assert the response for {no cookie, teacher-of-this-room, teacher-of-another-room, waiting student, admitted student, act-as-forced student}. This single table would have surfaced F-08, F-14 and F-12.
3. `rotateVisibleSample` / `pinSpeaker` unit tests against a real Redis: sticky-pin survival across rotation, pin cleanup on leave, concurrency (F-23).
4. `resolveRoomAccess` truth-table tests — it is the security keystone and is currently only exercised manually.
5. Playwright E2E for join → waiting → admit → speak → pin → mute, derived directly from `docs/VERIFY.md`.

### F-58 · Significant dead code and dead state · **Medium**
**Files:** verified by grep across `apps/web/src`

| Item | Location | Note |
|---|---|---|
| `unpinSpeakers` | `lib/sample.ts:47-51` | **0 call sites** — exported and never used |
| `getStageMode` | `lib/redis.ts:50-55` | **0 call sites**; `state/route.ts:77-81` inlines the same logic |
| `getWhiteboardWriteAllowed` | `lib/redis.ts:57-61` | **0 call sites**; `state/route.ts:82` inlines the same logic |
| `chromeVisible` state | `ClassroomRoom.tsx:1286,1680` | never set to `false`; the auto-hide branch is unreachable (F-15) |
| `bumpChrome` | `ClassroomRoom.tsx:1413-1417` | no-op wrapper around `setChromeVisible(true)` |
| `visibleIdentities` prop | `ClassroomRoom.tsx:77,84` | explicitly discarded: `void _visibleIdentities` |
| `canPublishVideo` prop | `Controls.tsx:64,77` | explicitly discarded: `void _canPublishVideo` |
| `SPEAKER_PIN_TTL_SECONDS` | `.env.example:63-64`, `compose:72` | marked "Deprecated … unused" but still wired through and still asserted by `docs/VERIFY.md:52` ("~18s TTL") |
| empty `if` block | `stage/route.ts:30-34` | `if (mode === 'screen' \|\| mode === 'idle') { /* comment only */ }` |
| `keys.admitted`, `keys.waiting` | `redis.ts:30-31` | written, never read (F-43) |
| `Experimental` config | `next.config.mjs:5-13` | `serverActions` (no `"use server"` in tree) and `canvas` external (not a dependency; would throw `MODULE_NOT_FOUND` if ever reached server-side) |
| `speakerPinUntilMute` | `health/route.ts:38` | hardcoded `true`, unrelated to config |

The two `void _prop` discards are the most interesting: `ParticipantGrid` is handed `visibleIdentities` — the one place the sample cap *could* be enforced in the teacher video tab — and throws it away (F-17).

### F-59 · Typing is loose at exactly the security boundary · **Medium**
**Files:** `apps/web/src/app/api/rooms/[code]/messages/route.ts:1-30`, `Whiteboard.tsx:110,242,270`, `ClassroomRoom.tsx:497`

- `messages/route.ts:11` types `room.status` as `string` rather than Prisma's generated `RoomStatus`, so `room.status === 'ENDED'` comparisons are unverified string comparisons. (Prisma enums *are* generated as string unions — the type is being thrown away, not unavailable.)
- `ClassroomRoom.tsx:497` declares a hand-rolled structural type for `teacherPub` instead of using `RemoteTrackPublication | null` from `livekit-client`, then has to cast `pub?.track?.mediaStreamTrack`.
- `Whiteboard.tsx` uses `useRef<any>` for the editor (line 110) and `changes: any` (line 242) — the tldraw store-diff shape is the most complex data in the app and is entirely untyped. `applyDiff` does non-trivial `Object.values` / array-tuple unwrapping with no type safety.
- Every `roomFetch(...)` result is `.json()`-ed with no validation, and `ClassroomRoom.tsx:2133` assigns it to an untyped `state` that is then read as `state.me.canPublishVideo`, `state.admitted`, etc. A server-side shape change breaks the client silently at runtime.
- Response shapes are duplicated as string literals in ~6 places (`'ENDED'`, `'ADMITTED'`, `'STUDENT'`, `'TEACHER'`, `'LIVE'`, `'WAITING'`) with no shared type.

**Fix:** generate a shared `contracts.ts` from the Prisma enums, validate all API responses with zod at the client boundary (zod is already a dependency and already used on most write paths), and type the tldraw editor as `Editor` from `@tldraw/editor`.

### F-60 · Error handling: every failure is a generic 500, and several are silently swallowed · **Medium**
**Files:** all `api/**/route.ts`; `livekit.ts:111-114,130,134`; `ClassroomRoom.tsx:1176,1188,1246,1389,1407`

- Catch blocks uniformly do `console.error(e); return jsonError('... failed', 500)` — the client gets a generic string and the operator gets an unstructured stack trace with no request ID. For F-40 (Redis `end`) and F-46 (LiveKit down), a student sees "Failed to load room" with no way to know it's transient.
- `livekit.ts` swallows **all** three failure modes with `console.warn` and returns `void`: `updateParticipant` (line 113), `mutePublishedTrack` (line 130), `listParticipants` (line 134). This is the mechanism behind the mute-enforcement gap in F-03 — the caller has no idea enforcement failed, and `mute/route.ts:81` doesn't even await it.
- `ClassroomRoom.tsx:1176-1188` — if `createLocalVideoTrack` or `publishTrack` fails, the student silently has no video with **no UI feedback and no retry**, because `publishingVideo.current` is only reset on the next `canPublishVideo` change.
- `Whiteboard.tsx:201` and `353` swallow fetch errors entirely, so a broken sync is invisible to everyone.

**Fix:** return a stable error `{code, message, retryable}`; surface a "camera unavailable — retry" affordance; make the LiveKit mute path return a boolean the route can turn into a `207`-style partial-success response, and log with structured fields + a request ID.

### F-61 · Docs contradict the code in seven places · **Low**
**Files:** `README.md`, `docs/*.md`, `.env.example`

| Doc claim | Reality |
|---|---|
| `README.md:40,221` "chat … cleared from API when room is ENDED" | Never cleared; reappears on the next session (F-05) |
| `README.md:162` `LIVEKIT_API_KEY/SECRET \| generated` | No script generates them (F-51) |
| `README.md:211` "~20 rooms × ~150 attendees" | ~2–3 rooms × 10–15 (F-27), and the UDP port range caps a room at ~100 (F-28) |
| `README.md:38` pin "last ~18s" | Until mute (F-02); `docs/VERIFY.md:52` still says "~18s TTL" |
| `README.md:44` "non-sampled video **never** leaves the student device" | Client-side only (F-01) |
| `README.md:87` seeded `teacher@example.com` / `password123` | No `prisma/seed.ts`, no `prisma.seed` config, no seeding in the entrypoint. If it *does* exist in a live DB it's a trivially guessable credential. |
| `docs/DEPLOY-VPS.md:3,11` "Postgres/Redis stay reachable on 127.0.0.1" | Postgres listens on `0.0.0.0` (verified) |

**Fix:** treat the README as a specification and reconcile it with the code as part of the P0/P1 work — several of these are the *only* statement of the intended security model, and they currently describe behaviour the code does not have.

---

# Prioritized top-10 action list

Ordered by *expected damage reduction per unit of effort*. Items 1–5 are all "before this touches a public IP" items.

| # | Action | Refs | Effort |
|---|---|---|---|
| **1** | **Rotate and purge secrets.** `LIVEKIT_API_SECRET` and `NEXTAUTH_SECRET` to fresh `openssl rand -hex 32`; make `sync-livekit-keys.sh` generate them if absent; `git rm --cached infra/livekit.yaml` + `git filter-repo` to purge history; ship `.example` files; `chmod 600`. The current LiveKit key is admin on the SFU and is in the repo. | F-20, Security §4 | S |
| **2** | **Enforce the video sample server-side.** Apply `canPublishSources` (no `CAMERA`) in the token grant when the student is not in the sample, and push membership changes via LiveKit `updateParticipant`. This is the product's central privacy promise and it is currently a UI convention. | F-01 | M |
| **3** | **Fix migration 3 and kill the `db push` fallback.** `d.rn::int`; `migrate resolve --rolled-back`; fail-closed entrypoint; move migrations to a one-shot service; add the `migrate diff` CI check. Today the schema is produced by a data-loss-capable fallback on every boot. | F-38, F-39, F-45, F-44 | S |
| **4** | **Stop Postgres being internet-reachable, and bound Redis.** `listen_addresses=127.0.0.1`, drop the `classroom_dev_password` fallback, add `--maxmemory 192mb --maxmemory-policy allkeys-lru`, and add a size/shape cap to `PUT /whiteboard` (currently an unauthenticated-ish Redis OOM once students may draw). | Security §4, F-13, F-33 | S |
| **5** | **Fix the polling storm.** Delete the duplicate `/state` poller; pipeline all Redis reads in `/state` into one `MULTI`; stop the DB lookup inside `getTeacherSession`; add a ~1 s server-side cache on `/state`; gate the whiteboard poll on a version counter. Today: ~1,350 PG queries/s and ~1,050 Redis RTT/s at the documented 150 students. | F-21, F-22, F-24, F-41 | M |
| **6** | **Add rate limiting** on login (bcrypt cost-12 is a CPU DoS as written), register, join, and message send. | F-11, F-37 | M |
| **7** | **Fix the three product-correctness bugs:** clear/partition `Message` rows on room reopen (cross-session chat leak); unpin a speaker when the student mutes their own mic; refresh the 6h LiveKit token on a timer and on sample/mute changes. | F-05, F-02, F-03 | M |
| **8** | **Rebuild the Docker image to ~250 MB** (`npm ci` + cache mounts, `--chown` copies instead of `chown -R`, drop devDependencies from the runner), add `CMD` + `exec "$@"`, and add `stop_grace_period: 45s`. | F-31, F-44, F-45 | S |
| **9** | **Un-blow the ops defaults:** real limits and log caps on all services, a LiveKit healthcheck with a real socket probe in `/api/health`, Postgres tuning for 2 GB, `COOKIE_SECURE=true` in the TLS profile, `Permissions-Policy: camera=(self)`, HSTS, and `chmod 600` on the env files. | F-27, F-46, F-47, F-29, F-36, F-52 | M |
| **10** | **Establish a test floor:** the route-handler authz matrix, a `migrate diff` gate, `rotateVisibleSample`/`pinSpeaker` tests against real Redis, and `resolveRoomAccess` truth tables — then reconcile `README.md` with actual behaviour. There are currently **zero** automated tests and no CI. | F-57, F-61, F-08, F-14 | L |

**Two cheap wins worth doing immediately regardless of ordering:** bump `next` to ≥14.2.25 (CVE-2025-29927; not currently reachable but the pin is below the fix) and add `typecheck` + a `lint` script. Both are one-liners that close a real finding.

---

## What is genuinely good

Worth preserving through any refactor:

- **The selective-publish architecture is the right call.** Putting the sampling decision in Redis + Postgres and shipping only a 6-member set to the SFU is exactly the right lever for a 150-person class, and the hard cap of 6 is enforced in `clampMaxVisible` at every entry point.
- **Identity never trusts the client for role.** `room.teacherId !== teacher.id` is checked on every teacher-only route (`admit:19`, `mute:26`, `stage:21`, `settings:18`, `end:13`, `pin:17`, `rotate:16`, `write:21`), independently of the act-as mechanism. The act-as header is downgrade-only (F-14) and never escalates.
- **The student-teacher chat scoping is correct.** `messages/route.ts:151-203` refuses to let a student DM another student, refuses teacher→teacher, and validates DM recipients as `role: 'STUDENT', status: 'ADMITTED'` in the room. The scope filter (108-116) is exactly right.
- **Waiting-room gating is consistent.** `token/route.ts:33-36` blocks `WAITING` and `LEFT` participants; `whiteboard/route.ts:27` requires `ADMITTED`; `messages` requires `ctx.admitted`.
- **No XSS anywhere** (F-19) — no `dangerouslySetInnerHTML`, no `innerHTML`, no `eval`, and student-controlled display names flow only through JSX text or `Avatar`'s initials slice.
- **The tldraw camera fix is thoughtful.** `unlockCamera` (`Whiteboard.tsx:64-75`) handles the `setCameraOptions` merge semantics correctly (it patches the *existing* `constraints` rather than replacing them), and `documentOnlySnapshot` (86-92) strips session/camera/pointer records so a snapshot can't yank another user's pan or zoom. That is a subtle bug most implementations would get wrong.
- **The `applyingRemote` ref guard** (`Whiteboard.tsx:111, 444`) correctly breaks the store-listen → publish → receive → apply → listen feedback loop.
- **`resolveAppUrl` deriving public links from the request** (`lib/url.ts:48-66`) is a genuinely thoughtful operator convenience — a bare-IP VPS works without reconfiguration. (It just needs the `X-Forwarded-Host` trust tightened — F-35.)

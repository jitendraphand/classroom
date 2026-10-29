# One system: the contract between server and apps

The classroom is one system: the server (`apps/web`, Next.js + Postgres +
Redis + LiveKit), the student web app (any browser), and four teacher
clients that must behave the same in class:

| Client | Where | Talks to the server through |
| --- | --- | --- |
| Web teacher | `apps/web` (this branch, `main`) | the web app's own code |
| Windows teacher app | `windows` branch (Electron) | `src/shared/web/*`: byte copies of `apps/web/src/lib` |
| Android teacher app | `android` branch, `apps/android` | Kotlin ports, checked against the web code by tests |
| AI teacher | `apps/ai-teacher` | imports `apps/web/src/lib/whiteboard` directly |

This page is the contract. Changing anything here means changing every
client, or keeping the old form working (see *Compatibility rules*).

## Identities and grants (LiveKit)

One LiveKit room per class session: `classroom_<CODE>_<sessionId>`. The
session id rotates when a teacher's permanent room is reopened, so an old
token never joins a new class.

| Identity | Who | Grant |
| --- | --- | --- |
| `teacher_<participantId>` | the teacher (any client, AI included) | publish mic/camera/screen, **publish data**, subscribe |
| `teacher_<participantId>__screen` | Windows native screen publisher (sidecar) | publish screen + screen audio only; no subscribe, no data |
| `student_<participantId>` | a student | subscribe; mic/camera only while the server allows (`updateParticipant`); **no data** |
| `adminpreview_…`, `adminobserver_…` | admin *Live* page | hidden, subscribe only |

- **One teacher connection per class.** The token route always issues the
  same `teacher_…` identity, and LiveKit lets one connection hold an
  identity: a second device (another tab, the Windows or Android app, an AI
  teacher on the same account) disconnects the first.
- **Teacher presence** = a `teacher_…` identity (not `__screen`) is in the
  room. Students' mics follow it (`lib/teacherPresenceLogic.ts`,
  `docs/TEACHER_PRESENCE_MIC_LOCK.md`).
- Students' publish rights are pushed by the server
  (`lib/livekit.ts` `pushStudentPermissions`); clients never grant them.

## Data topics

Only the teacher and the server publish data. Everything a student sends
(chat, hand, strokes, board ops, draw requests) goes to an HTTP route that
checks the permission and relays a server-originated packet with the
student's identity stamped (`by`). **Receivers drop any packet whose sender
is a `student_…` identity** (`lib/realtimePackets.ts` `senderKind`).

Every packet is UTF-8 JSON with `v: 1`.

| Topic | Sender | Packets | Defined in |
| --- | --- | --- | --- |
| `wb` | teacher; server (relayed student ops, snapshot requests) | `ops` `{ops, by?}`, `snap` `{doc, z}`, `chunk` `{id, i, n, d}`, `req` `{to}`, `end`, `laser` `{pts}` | `lib/whiteboard/model.ts` |
| `chat` | server; teacher (`senderRole: TEACHER`) | stored chat message (scope everyone / private) | `lib/realtimePackets.ts` |
| `cls-signal` | server | `hand` `{raised, participantId}`, `draw-req` `{on, participantId}`, `draw-allow` `{on, participantId, identity, name, until}` | `lib/realtimePackets.ts` |
| `cls-state` | server | `state` `{spread}` (refetch `/state` within `spread` ms), `mute` `{muted}` (to the named students) | `lib/roomNudge.ts`, `lib/pollPolicy.ts` |
| `draw` | server | student drawing on the shared screen: `pts` `{id, by, name, c, from, pts}`, `del`, `clear` | `lib/drawLogic.ts` |
| `tink` | teacher | teacher marks on the shared picture: `up` `{stroke}`, `del` `{id}`, `clear`, `snap` `{strokes}` (coordinates 0..1 of the video box) | `lib/teacherInk.ts` |

HTTP polls are a safety net only: while LiveKit is connected the teacher
polls `/state` every 60 s and students every 60-120 s; pushes do the rest
(`lib/pollPolicy.ts`).

## Whiteboard (`wb`)

- Page 1920 x 1080 in every client; students scale it. Up to 50 pages, 4000
  items per page, 4000 points per stroke.
- Items: `stroke` (pen/highlighter, optional pressure 0-100), `shape`
  (`line`, `arrow`, `rect`, `ellipse`, `tri`, optional fill), `text`, `img`.
  Every item carries `by` (the author's identity).
- Ops: `add`, `pts` (live stroke points), `del`, `clear`, `bg`, `newpage`,
  `delpage`, `go`, `delBy`, `xf` (move/resize).
- Backgrounds: `white`, `grid`, `lined`, `dots`, `graph`, `black`.
- The teacher's device is the board's host: it applies ops, answers `req`
  with a `snap` (deflated when `z: 1`, split into `chunk`s of 12,000
  characters), and stores the latest snapshot on the server
  (`POST /api/rooms/<code>/whiteboard {action: "snap"}`, debounced) so a late
  joiner gets the board even when the teacher's device is slow
  (`{action: "stored"}`).
- Students draw on the board only while allowed (`draw-allow`); their ops go
  through `POST /whiteboard {action: "ops"}`, are cleaned
  (`sanitizeStudentOps`: their own items only) and relayed with `by`.
- Undo/redo is local to the teacher's device and sent as ordinary ops.
  Snapping a stroke to a shape records two undo steps (shape, then the
  original stroke) in web, Windows and Android alike.

## HTTP endpoints the apps use

All teacher clients sign in with a cookie session (`/api/auth/login`,
`/me`, `/status`, `/logout`, `/change-password`). Writes carry JSON bodies;
the CSRF rules (`lib/csrf.ts`) check `Origin` / `Sec-Fetch-Site` when a
browser sends them, so the apps' own HTTP clients pass as non-browser callers.

| Endpoint | Used by |
| --- | --- |
| `GET /api/teacher/schedule`, `/api/teacher/home` | dashboard (timetable, live class) |
| `POST /api/teacher/sessions/start` | start a timetabled or ad-hoc class |
| `POST /api/rooms/<code>/token` | LiveKit token for the teacher identity |
| `POST /api/rooms/<code>/screen-token` | Windows sidecar token (`__screen`) |
| `GET /api/rooms/<code>/state` | roster, waiting, hands, settings |
| `/admit`, `/mute`, `/hand`, `/spotlight`, `/stage`, `/pin-student`, `/video-panel`, `/settings` | teacher actions |
| `/messages` (+ `/messages/stream`) | chat history and sending |
| `/whiteboard`, `/draw` | board on/off, snapshots, student drawing permission |
| `/end`, `/leave` | end the class / leave it running |
| `GET /api/desktop/windows` | Windows app: latest/minimum version and download link |
| `GET /api/desktop/android` | Android app: same, from `ANDROID_APP_LATEST`, `_MINIMUM`, `_URL` |

The update endpoints let a school roll out a new app version from its own
server: the apps show "update available" (or "update required" below the
minimum) with the school's download link.

## Shared behaviour

| Behaviour | Source of truth | Copies |
| --- | --- | --- |
| Whiteboard model, ops, codec | `lib/whiteboard/model.ts`, `codec.ts`, `session.ts` | Windows: byte copies; Android: `wb/` port; AI teacher: direct import |
| Poll intervals, people search, video quality | `lib/pollPolicy.ts`, `peopleSearch.ts`, `videoQuality.ts` | Windows: byte copies; Android: ports |
| Trust rules | `lib/realtimePackets.ts` | Windows: byte copy; Android: `RealtimeTest` |
| Rosters for large classes (150 rows, "Show more", hands first) | web roster | Windows panel, Android `ClassLogic.rosterWindow` |
| Noise removal and voice focus | `lib/audio/voiceSettings.ts`, `voiceProcessor.ts`, `public/audio/voice-focus-worklet.js` | Windows: byte copies; Android: `VoiceFocus.kt` (same constants) |

## Drift checks (CI)

| Check | Fails when |
| --- | --- |
| Windows `tests/webSync.test.ts` (CI checks out `main` beside it) | a shared module or worklet differs from `apps/web` on `main`: run `node scripts/sync-web.mjs` |
| Android `WebParityTest`, `WbV2Test`, `RealtimeTest`, `VoiceFocusTest` | the Kotlin port disagrees with the web model, trust rules or voice constants |
| `apps/ai-teacher` typecheck + tests (CI job `ai-teacher`) | the web whiteboard model changes shape under the AI teacher |

Because the Windows check compares against `main`, web changes to shared
modules land on `main` before the matching `windows` commit is pushed.

## Compatibility rules

1. Receivers ignore unknown packet types, unknown ops and unknown fields;
   senders never rely on an older client understanding a new one.
2. A new op or item kind must degrade on old clients (ignored, never
   corrupting the board): `applyOp` skips unknown ops and pages, and
   `cleanItem` drops items it does not know.
3. `v: 1` changes only for a breaking change, and then clients must accept
   both versions for one release.
4. New server-side permissions are enforced on the server; clients only
   reflect them (a hidden button is never the protection).
5. Minimum app versions (`WINDOWS_APP_MINIMUM`, `ANDROID_APP_MINIMUM`) are
   raised only after the new apps are on the school's download page.

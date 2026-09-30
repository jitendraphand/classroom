# Students are force-muted while the teacher is not in class

**Rule.** Whenever the teacher is not connected to the class's LiveKit room
(has not joined yet, pressed Leave, closed the tab, or lost internet), no
student may publish a microphone. When the teacher is connected again the
permission comes back, but nobody is unmuted automatically: each student
unmutes themselves. A teacher mute (per-student or **Mute all**) always wins
over presence; presence never un-mutes a teacher-muted student.

## How it is enforced

Presence is the **live LiveKit connection**, never the DB roster.

| Layer | What it does |
|-------|--------------|
| `infra/livekit.yaml` → `webhook:` | LiveKit posts `participant_joined` / `participant_left` / `participant_connection_aborted` / `room_finished` to the web app, signed with the API key/secret. |
| `POST /api/livekit/webhook` | Verifies the signature with `WebhookReceiver` (401 on missing/bad signature or tampered body), ignores events for another session of the same permanent code or an ended class, then runs `handlePresenceEvent` (`lib/teacherPresenceLogic.ts`). Exempt from the browser CSRF guard (`CSRF_EXEMPT_PATHS` in `lib/csrf.ts`): it has no browser Origin and its own auth. |
| Teacher joined / left | Presence is recomputed from `RoomService.listParticipants` (by participant SID, so a duplicate-identity reconnect is handled), stored in Redis `room:<CODE>:teacher-present` tagged with the session id, and every connected student gets `updateParticipant` with microphone removed from `canPublishSources` (plus `mutePublishedTrack` on any live mic) — or restored if the teacher is back and that student is not teacher-muted. |
| Student joined while the teacher is away | That student is locked too (covers a token minted from a stale cache). |
| `GET /api/rooms/:code/token` | Students minted while the teacher is absent get **no microphone** in the grant (`micLocked`). A teacher token mint clears the cached presence so a missed webhook cannot keep the class locked. |
| `setParticipantPublishPermissions` | Every other permission push (sample rotation, mute / unmute all) goes through the same gate, so "Unmute all" while the teacher is away does not re-grant mics. |
| Student UI | `useTeacherLive` watches the LiveKit room: when no teacher participant is connected the mic turns off, the unmute button is disabled and shows **"Mic locked — teacher not in class"**. The mic stays off when the teacher returns. |

Without a fresh webhook record (webhooks not configured, Redis flushed) the
server asks LiveKit directly and caches the answer for 5 s. If LiveKit cannot be
reached at all the check **fails open** (logged) rather than muting the whole
class on an infrastructure error.

## Timing

`participant_left` fires when LiveKit drops the teacher's participant: at once
for Leave / tab close, and for a lost connection after the SFU gives up on it
(roughly 15–30 s). Until then students can still talk; the student UI locks as
soon as their own LiveKit client sees the teacher disconnect.

## Deploy

1. `./scripts/sync-livekit-keys.sh` — regenerates `infra/livekit.yaml` with the
   `webhook:` block (`LIVEKIT_WEBHOOK_URL`, default
   `http://127.0.0.1:3000/api/livekit/webhook` for host-network compose).
2. `docker compose up -d --build --force-recreate livekit web`.
3. Check: `docker compose logs livekit | grep -i webhook` shows no delivery
   errors after a teacher joins; students' mic buttons unlock.

Without the webhook, students who join before the teacher keep a mic-less token
until they reload, and a teacher leaving does not revoke mics server-side (the
student UI still locks).

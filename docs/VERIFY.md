# Verification checklist

## Health
```bash
curl -s http://localhost:3000/api/health
# expect status healthy
curl -sI http://localhost:3000/favicon.ico | head -1
# expect 200
```

## 1. Screen share + annotate
1. Teacher: create room → Enter classroom → Share screen (one click).
2. Confirm compact Share bar appears and students see the shared screen.
3. Teacher Annotate → draw; student sees strokes over the share.
4. Stop share → stage idle, annotations cleared.


## 2. Join link does not hijack teachers
1. Sign in as teacher, copy join link `/join/CODE`.
2. Open that link in the **same** browser profile.
3. Expect student join form + banner “signed in as a teacher… Continue as student”.
4. Click continue → enter name → waiting room as student (not teacher classroom).
5. Teacher lobby in another tab should still work after visiting dashboard (clears act-as).

## 3. Screen-share layout
1. Teacher: Share screen.
2. Expect large primary screen tile; camera/self tiles secondary (smaller row).

## 4. Viewport / footer
1. Classroom should fit `100dvh` without page scroll.
2. Footer controls always visible; video/roster scroll internally.

## 5. LiveKit versions
- Server image: `livekit/livekit-server:v1.12.0`
- Client: `livekit-client` ^2.6 (lockfile ~2.22.x)
- Confirm no reconnect loop in browser console after connecting.

## 6. Grammar
- Teacher lobby with 1 student: “1 student admitted” (not “1 students”).

## 7. Faster sample rotation (~8s)
1. Set `SAMPLE_ROTATION_SECONDS=8` (default) in `.env`.
2. Admit more students than `maxVisibleVideos`.
3. Poll `/api/rooms/{CODE}/state` every few seconds — `visibleIdentities` should change about every 8s (state polling ~4s triggers `ensureSampleFresh`).
4. Student not in sample: local preview only; when identity enters sample, camera starts publishing without remount.

## 8. Active speaker pin
1. Teacher in classroom; student **not** in visible sample turns on mic and speaks.
2. Teacher client hears ActiveSpeakers → `POST /api/rooms/{CODE}/sample/pin` with `{ identity }`.
3. Expect that student to appear in `visibleIdentities` and start publishing video within one state refresh (~4s).
4. Repeat pin for same identity within 2s should be rate-limited (no thrash).
5. Manual **Rotate sample** should prefer keeping recently pinned speakers (~18s TTL).

## 9. Mute all / unmute all
1. Teacher Controls or Roster → **Mute all students**.
2. Every admitted student should show muted; mic button label **Muted by teacher** and disabled — student cannot unmute.
3. Teacher **Unmute all** clears `mutedByTeacher`; students can use mic again.
4. Per-student Mute/Unmute still works.
5. API: `POST /api/rooms/{CODE}/mute` with `{ "all": true, "muted": true|false }` (teacher session cookie required).

## 10. In-class chat
1. Teacher + admitted student in classroom. Sidebar → **Chat**.
2. **Student → teacher:** student sends a message (fixed “To teacher”). Teacher sees it with **To teacher** badge. Other students must **not** see it.
3. **Teacher broadcast:** teacher selects **Everyone**, sends. Both teacher and student see it with **Everyone** badge within ~2s (or instantly via LiveKit `chat` topic).
4. **Teacher DM:** teacher picks one student name, sends. Only that student + teacher see it (**DM** badge). Other students do not.
5. **Persistence:** hard-refresh while class is LIVE → history still loads from `GET /api/rooms/{CODE}/messages`.
6. **Ended class:** after teacher **End class**, `GET` returns `{ messages: [] }` (or empty); `POST` returns **410**.
7. Waiting (not admitted) students cannot POST/GET messages (403).
8. API shapes:
   - `GET /api/rooms/{CODE}/messages` → `{ messages: [{ id, senderName, senderRole, body, scope, recipientName, createdAt, ... }] }`
   - `POST /api/rooms/{CODE}/messages` body `{ "text": "...", "to": "teacher" | "all" | "<studentParticipantId>" }`


## 11. Teacher mute cannot be self-unmuted (HIGH)
1. Teacher + admitted student in classroom (separate profiles preferred).
2. Teacher **Mute all** or per-student **Mute**.
3. Within ~2s student state shows `mutedByTeacher: true`; mic button label **Muted by teacher**, disabled.
4. Student cannot toggle mic; LiveKit audio stays unpublished (server also strips mic publish permission + mutes tracks).
5. Teacher **Unmute all** / unmute student → mic control works again.

## 12. End class kicks students (no whiteboard 401 spam)
1. Student stays on `/classroom/CODE` (video or screen stage).
2. Teacher **End class**.
3. Within ~2s student sees **Class ended** screen (not stuck in classroom).
4. Browser network: annotate/chat/state stop retrying after 410/ENDED — no 401 spam loop.
5. Join link for that code shows class ended.

## 13. Chat attribution with same browser profile
1. Teacher signed in; same profile: join as student (Continue as student) → admit.
2. Student tab Chat: send message → labeled with **student displayName** + **To teacher** (not Demo Teacher / Everyone).
3. Teacher tab sees that message correctly attributed.
4. While Roster is active, a new incoming message increments Chat tab unread badge; opening Chat clears it.

## Rebuild / health
```bash
docker compose build web && docker compose up -d web
curl -s http://localhost:3000/api/health
# expect "status":"healthy"
```

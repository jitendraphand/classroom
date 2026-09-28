# Share HUD — teach while screen sharing

Lets a teacher keep controlling the class while their screen-share window (or
anything else) is in front, without touching the classroom tab.

Built alongside the review fixes; see `CODE_REVIEW.md` / `FIX_NOTES.md` for the
unrelated correctness work in the same commit.

---

## What was built

| File | Role |
|---|---|
| `apps/web/src/components/classroom/TeacherShareHud.tsx` | The HUD UI + `useShareHud()` window lifecycle (PiP / popup / inline) |
| `apps/web/src/components/classroom/ScreenAnnotator.tsx` | Annotation overlay + `useScreenAnnotate()` LiveKit transport |
| `apps/web/src/app/api/rooms/[code]/annotate/route.ts` | Bounded Redis snapshot for late joiners / reconnects |
| `apps/web/src/app/hud/page.tsx` | Empty same-origin shell that hosts the popup window |
| `apps/web/src/lib/redis.ts` | `room:{code}:screen-annotate` key |
| `ClassroomRoom.tsx` | Wires the HUD into the share lifecycle; students render the overlay on `TeacherScreenStage` |

### A. Share HUD

Auto-opens **once per share session** when the share starts, and can be reopened
from the teacher toolbar (**"Open share controls"**) or promoted with **"Pop out"**
from the HUD header. Contents:

- Mic on/off, **Stop share**, **Annotate** toggle
- **Mute all** / **Unmute all**
- Tabs: **Chat** (teacher rules unchanged), **Hands** (Lower), **Roster** (per-student mute)

All three hosts render the *same* React subtree; only the mount point changes.
The HUD's own chrome is styled by an inlined stylesheet rather than Tailwind, so
it renders correctly in a PiP/popup document that starts with an empty `<head>`.
`Chat` does use Tailwind, so the host document's stylesheets are copied across
on a best-effort basis.

### B. Screen-share annotation layer

- Drawn on a transparent SVG composited over the screen share. **Independent of
  the whiteboard** — `stageMode` stays `screen`; nothing switches stages.
- Tools: pen, highlighter (35% opacity), eraser (hit-test removes whole strokes),
  5 colours, Clear.
- **Sync:** LiveKit reliable data messages on topic `annotate`
  (`begin` / `point` / `end` / `erase` / `clear`), following the same pattern as
  `Chat.tsx` and `Whiteboard.tsx`. A debounced (2 s) Redis snapshot backs late
  joiners and is re-fetched on `RoomEvent.Reconnected`.
- **Coordinates are normalised 0..1 against the video *content* rect**, not the
  element box. The overlay computes the letterbox geometry from the `<video>`'s
  `videoWidth/videoHeight` and an `object-contain` fit, so a 4K teacher screen
  maps correctly onto any student viewport with no resolution negotiation. A
  `0..100` SVG user space plus `vector-effect="non-scaling-stroke"` keeps the pen
  a constant pixel width while the geometry stretches.
- **Bounds:** 14 KB per data packet, 400 strokes, 1,200 points/stroke,
  2,000 strokes and 256 KB per snapshot, 512 KB per request body. Same discipline
  as the whiteboard cap (F-13). Rejected writes leave Redis untouched.

---

## Browser support matrix

| Host | Requirement | Behaviour | Always on top? |
|---|---|---|---|
| **Document PiP** | Chromium 116+ (Chrome/Edge 116+, Opera) | Separate always-on-top window, survives minimising the classroom tab | **Yes** |
| **Popup** | Any desktop browser with `window.open` and pop-ups allowed | Separate window; platform gives web content no always-on-top, so you may have to raise it | No |
| **Inline sheet** | Anything else — mobile Safari/Firefox, or pop-ups blocked | Bottom sheet in the classroom page; collapses to a small pill | n/a |

Mobile also gets `@media (pointer: coarse)` sizing (44 px tap targets) and
`env(safe-area-inset-bottom)` padding.

### Known limits

- **Mobile cannot be genuinely always-on-top.** No mobile browser exposes
  document PiP, and a backgrounded tab throttles timers. The in-page sheet works
  while Classroom is visible; if you need another app, use the browser's own
  split view or the browser's picture-in-picture. The HUD says this inline.
- **The popup fallback needs a same-origin document.** `window.open('')` yields an
  *opaque origin*, and the popup's `fetch()` calls would then be cross-origin, so
  the browser omits the session cookies and **every** HUD action 401s. This is why
  `/hud` exists. A same-origin check on mount degrades to the inline sheet rather
  than shipping a HUD whose buttons do nothing.
- **Roster / hands freshness in the HUD** rides the existing 2 s `/state` poll.
  Chat and annotations arrive over the LiveKit data channel, so they are
  unaffected; a heavily throttled background tab may delay the roster.
- **Annotations do not follow the teacher's zoom.** Coordinates are in video
  space, so two teachers sharing different window sizes will place a stroke at a
  different on-screen position. There is one share per stage, so this is only
  visible after a share restart.

---

## How to try it

```bash
cp -n .env.example .env        # if you do not have one yet
./scripts/sync-livekit-keys.sh
docker compose up --build -d
curl -s http://localhost:3000/api/health
```

1. Teacher → `/login` (or register) → **Start class** → note the code.
2. Student (incognito or a second browser) → `/join/CODE` → name → waiting room.
3. Teacher → **Enter classroom** → allow camera/mic → **Admit** the student.
4. Teacher clicks **Share screen**.
   - A **Class controls** window appears on top (Chromium) or the sheet slides up
     in-page (other browsers).
5. **Cover or minimise the classroom tab.** The controls window keeps working:
   - click **Annotate**, then draw on the preview — the student sees strokes over
     the share;
   - switch **Hands** → **Lower**; **Roster** → **Mute**;
   - send a message in **Chat**, and watch the student's reply appear.
6. **Close** the controls window — the share continues, and the toolbar now shows
   **"Open share controls"**.
7. **Stop share** — the HUD tears itself down, the stage returns to idle and the
   annotation layer is cleared for everyone.

### Manual checks

- [ ] Chromium: a second always-on-top window opens; minimising Classroom does not affect it
- [ ] Firefox/Safari: no Document PiP → popup or in-page sheet; banner explains which
- [ ] Block pop-ups: in-page sheet, banner reads "This browser has no pop-out mode…"
- [ ] Annotate: pen, highlighter, eraser and Clear all reach the student's stage
- [ ] Switching to the Whiteboard tab clears the annotation layer
- [ ] Closing the HUD does **not** stop the share
- [ ] Stop share (button, browser "Stop sharing" bar, or the Whiteboard tab) clears annotations and returns the stage to idle
- [ ] A student who joins mid-session sees the current annotations
- [ ] Mobile: sheet is usable, collapses to a pill, respects the home indicator

---

## Protocol reference

LiveKit data message, topic `annotate`, reliable:

```jsonc
{ "v": 1, "type": "begin", "from": "<identity>", "stroke": {
    "id": "s…", "tool": "pen" | "highlighter", "color": "#ef4444",
    "width": 3 | 18, "points": [[x, y], …] } }        // x, y ∈ [0,1]
{ "v": 1, "type": "point", "from": "<identity>", "id": "s…", "p": [x, y] }
{ "v": 1, "type": "end",   "from": "<identity>", "id": "s…" }
{ "v": 1, "type": "erase", "from": "<identity>", "ids": ["s…"] }
{ "v": 1, "type": "clear", "from": "<identity>" }
```

`GET|PUT /api/rooms/{code}/annotate` — `{ "strokes": Stroke[] }`. GET is allowed
for the room teacher and admitted students; PUT is teacher-only.

---

## Bug found and fixed while building this

`POST /api/rooms/{code}/hand` validated its body with
`z.union([{raised}, {participantId, raised}])`. zod objects strip unknown keys, so
`{ participantId, raised: false }` also satisfied the **first** branch; the union
always resolved there, `participantId` was silently dropped, and the request fell
through to the student-only path — so the teacher's **"Lower hand" button had
never worked** (it 401'd). Replaced with a single object schema carrying an
optional `participantId`. Verified: student raise 200, teacher lower 200,
`raisedHands` actually empties; student forging `participantId` still 401s.

## Not in scope

OS-level annotation outside the browser, Electron always-on-top windows,
changes to student selective-video sampling, and deployment.

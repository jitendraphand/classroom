# Student drawing on the shared screen & one student layout

## Student freehand drawing (replaces the old teacher annotation, which is removed)

**Flow**
1. While the teacher is sharing, a student taps the pen button ("Request to draw") on the
   right-hand control panel — it works like a hand raise (tap again to cancel).
2. The teacher sees a toast plus a pen badge in the roster (in-page roster and the share-controls
   Roster popup). Requests are listed first in the roster, earliest first.
   **Allow** gives that student the pen; **Revoke** takes it back.
3. Only one student can draw at a time. Allowing another student moves the pen to them.
4. The pen expires on its own after `DRAW_ALLOW_MS` (3 minutes). It also ends when the share stops.
   The student can tap **Done** to hand it back early.

**Drawing**
- Freehand strokes with the mouse, pen or finger. Pointer Events (with coalesced points) behave the
  same way on every device. A toolbar offers 3 colours (red / yellow / blue), an **eraser** (tap one of
  your own strokes to delete it), **undo** (your last stroke) and a countdown.
- Only the drawing student's own strokes can be erased or undone.

**Sync**
- Points are normalized to `0..1` of the *video picture*: the `object-fit: contain` box, not the
  letterbox. A stroke therefore lands in the same spot on every screen size.
- Students cannot publish LiveKit data (`canPublishData:false`), so the student client batches points
  every 80 ms and sends them to `POST /api/rooms/<code>/draw`.
- The server checks that the student is the current pen holder and that a share is live. It then
  stores the stroke in Redis and relays it to everyone as a **server-originated LiveKit data message**
  on topic `draw`.
- Clients only trust `draw` packets that come from the server: packets with a participant identity
  are ignored.
- Each packet carries the point index (`from`), so applying the same packet twice is harmless.
- Late joiners or reconnecting clients `GET /draw` to load the current strokes and holder, then apply
  live packets on top of them.
- Limits: 400 strokes, 1 200 points per stroke, 200 points per request.

**Where strokes render, each labelled with the drawer's name**
- Every student's view of the share, including the drawing student's own view.
- The teacher's in-page share preview.
- The share-controls popup: a **Drawing** panel at the top of the Roster tab with **Clear drawing**
  and **Revoke**. When the popup can show the live screen, the preview draws over it. When the
  teacher shares the entire screen in-page, strokes are drawn on a dark box with the screen's aspect
  ratio, to avoid a recursive "tunnel" capture.

**Clearing**
- The teacher's **Clear drawing** button.
- **Revoke**.
- The share stopping (stage goes idle).

Strokes are kept when the pen expires or moves to another student, so the class can still see
them. Room Redis keys are wiped when the class ends.

**Safety**
- Nothing is injected into the teacher's computer: no input events and no OS-level overlay.
- Strokes exist only inside the classroom web pages (an SVG layer over the video element). The
  teacher's real desktop and the captured video stream are never modified.

Code:
- `src/lib/drawLogic.ts`: pure logic, unit-tested in `tests/draw.test.ts`.
- `src/lib/drawServer.ts`: Redis + relay.
- `src/app/api/rooms/[code]/draw/route.ts`.
- `src/components/classroom/ShareDrawing.tsx`: provider, overlay, drawing surface.

## One student layout on every device / OS / browser

Students get the same classroom UI everywhere: iPhone, iPad, Android phones and tablets, and
Windows/Mac/Linux desktops in Safari/WebKit, Chrome/Edge/Samsung Internet and Firefox.

- **Control panel**: a vertical panel on the RIGHT edge, vertically centred. Button size scales with
  the viewport (`--rail-btn: clamp(34px, min(7.2vh, 5.2vw), 50px)`) and respects the right safe-area
  inset.
- **Teacher video**: a floating, draggable, minimizable panel, sized from the viewport.
- **Chat**: a floating window at the bottom-left that opens and closes. Its size and position come
  from `studentChatBox(vw, vh)`, and its storage key was bumped to `student_chat_v3`, so old
  per-device positions are reset.
- There are no user-agent or device layout branches. The old phone-only bottom bar and
  portrait/focus variants and `usePhoneLayout` are gone. Sizing depends only on the viewport
  (`src/hooks/useStudentLayout.ts`).
- **Fullscreen**: browsers with the Fullscreen API enter real fullscreen. iPhone Safari has none,
  so it gets **pseudo-fullscreen** (`html.pseudo-fullscreen`): a scroll-locked page at `100dvh` that
  looks the same. A "rotate for a bigger view" hint appears only on narrow portrait screens while a
  share is showing.
- `viewport-fit=cover`, `color-scheme: dark` and `text-size-adjust: 100%` stop browser-specific
  text inflation and forced dark modes.

Verification screenshots are in `/workspace/classroom-device-shots/`, made with Playwright device
emulation in Chromium, WebKit and Firefox.

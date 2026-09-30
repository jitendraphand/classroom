# E2E click-test checklist

Use two browsers (or normal + incognito). Start from a healthy stack (`GET /api/health` → healthy).

## A. Smoke (curl / load)

- [ ] `curl -s http://localhost:3000/api/health` → `status: healthy`
- [ ] `/`, `/login`, `/register`, `/join` render without console errors
- [ ] Favicon `200`

## B. Teacher auth + room

- [ ] Register new teacher (or login)
- [ ] Dashboard shows name/email; **Create room**
- [ ] Room code + join link appear; **Copy join link** works
- [ ] **Start class** goes straight to `/classroom/CODE` in teacher view, camera OFF
- [ ] Header **Copy invite link** / **Copy code** work; old `/teacher/room/CODE` redirects to the classroom

## C. Join as student (no teacher hijack)

- [ ] Open join link in **same** profile while teacher-signed-in
- [ ] Banner: signed in as teacher → **Continue as student for this tab**
- [ ] Enter display name → Waiting room (not teacher classroom)
- [ ] Incognito join with another name also reaches waiting room

## D. Admit / waiting room

- [ ] Classroom header shows **N waiting · Admit**; Roster lists waiters with avatars
- [ ] **Admit** one → student auto-enters `/classroom/CODE`
- [ ] **Admit all** works with multiple waiters
- [ ] Grammar: "1 student admitted" vs "N students"

## E. Classroom shell (layout)

- [ ] Fits `100dvh` — no page scroll; dock always visible
- [ ] Top bar: room name, code, sample count, Live badge
- [ ] **Share screen** once → share starts AND compact teacher controls appear
- [ ] Sidebar **Roster | Chat**; under ~1280px, sidebar toggle works (~900px usable)
- [ ] Empty video state shows empty-state card + local preview

## F. Camera / mic

- [ ] Allow camera+mic permissions
- [ ] Local preview mirrors; **Local only** vs **In sample** chip updates with sample
- [ ] Mic off/on via dock; when **Muted by teacher**, mic control disabled + hint
- [ ] Cam off shows avatar/initials fallback

## G. Selective sample + rotate + speaker pin

- [ ] Admit more students than `maxVisibleVideos`
- [ ] Only sample students publish; others stay local-only
- [ ] Teacher **Rotate sample** (dock) changes who is in sample within a refresh
- [ ] Student **not** in sample speaks → teacher pin path (`/sample/pin`) pulls them into sample (note: requires audible speech / LiveKit active speaker)

## H. Mute all / unmute / per-student

- [ ] Teacher dock or Roster → **Mute all** → all students muted; cannot self-unmute
- [ ] **Unmute all** restores student mic control
- [ ] Per-student Mute / Unmute in roster

## I. Screen share

- [ ] Teacher **Share screen** → large primary stage; cameras in secondary strip
- [ ] Stop sharing restores grid
- [ ] Student can share; teacher sees large tile

## J. Screen share + annotate
- [ ] Teacher: one click Share screen starts share + slim Share bar
- [ ] Teacher-only: students never see the Share bar
- [ ] Annotate draws on shared screen; student sees strokes
- [ ] Chat / roster / hands open from Share bar icons only while sharing
- [ ] Mobile: if getDisplayMedia blocked, HUD shows a clear reason (not silent no-op)
- [ ] Stop share clears annotations and returns stage to idle


## K. Chat

- [ ] Student message → teacher sees **To teacher**; other students do **not**
- [ ] Teacher **Everyone** broadcast → both see **Everyone** badge
- [ ] Teacher DM one student → only that student + teacher (**DM**)
- [ ] Unread badge when Chat tab inactive
- [ ] Refresh keeps history while class live
- [ ] After **End class**, chat POST → 410 / empty history

## L. Leave / end

- [ ] Student **Leave** → home; removed from roster eventually
- [ ] Teacher **End class** confirm → everyone out; join shows ended

## M. Visual QA notes

- [ ] Focus rings visible when tabbing controls
- [ ] Contrast OK on badges/chips
- [ ] No control dock covering video/whiteboard content

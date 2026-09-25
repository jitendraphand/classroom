# UI / UX overhaul

## Design direction

1. **Premium live-teaching shell** — Meet/Zoom-grade density with edtech calm: soft elevated dark surfaces, restrained brand blue, clear status semantics (success / warning / danger), no neon hackathon chrome.
2. **Readable type + spacing** — Inter (UI) + Outfit (display), tighter microcopy, consistent radii (`xl`/`2xl`), focus rings, and accessible contrast on badges/chips.
3. **Classroom-first layout** — Fixed `100dvh` app: top status bar → primary stage (screen/video or whiteboard) → secondary tile strip → right sidebar (Roster | Chat) → bottom control dock that never overlays content. Sidebar collapses under ~1280px via toggle.

## Design system

| Token / piece | Location |
|---|---|
| CSS variables + component utilities | `apps/web/src/app/globals.css` |
| Tailwind theme (brand, surface, shadows, motion) | `apps/web/tailwind.config.ts` |
| Fonts | Inter + Outfit in `apps/web/src/app/layout.tsx` |
| Primitives | `apps/web/src/components/ui/*` — Button, IconButton, Input, Badge, Card, Avatar, Tabs, EmptyState, Skeleton, Icons |
| Shell chrome | `apps/web/src/components/layout/AppHeader.tsx` |

Semantic chips on video/roster:

- **In sample** — emerald: publishing to teacher
- **Local only** — neutral: camera stays on device
- **Muted by teacher** — amber: student cannot self-unmute

## Pages restyled

- Landing `/`
- Auth `/login`, `/register`
- Teacher `/teacher/dashboard`, `/teacher/room/[code]`
- Student join `/join`, `/join/[code]` (waiting room)
- Live classroom `/classroom/[code]`

## Behavior preserved (not reinvented)

- Teacher auth, create room, waiting-room admit
- Selective student video sample + rotate + speaker pin
- Mute / mute-all / unmute-all (teacher-only unmute)
- Screen share, tldraw whiteboard sync, chat (student→teacher, teacher broadcast/DM)
- Join-as-student without teacher session hijack (`act-as`)

No recording, no new backend features, no LiveKit publish-rule changes.

## Screenshot suggestions (for E2E / review)

1. **Landing** — hero + preview mosaic with In sample / Local only chips
2. **Teacher dashboard** — create form + "Room ready" code card
3. **Teacher lobby** — waiting list with avatars + Admit / Admit all
4. **Student waiting room** — pulsing lobby card
5. **Classroom video** — large screen-share stage + secondary strip + dock
6. **Classroom sidebar** — Roster chips + Chat thread with scope badges
7. **Whiteboard mode** — full stage board with dock still visible
8. **~900px width** — sidebar toggle; dock wraps without covering stage

## Known visual debt

- tldraw ships its own light chrome inside the board (not themed to Classroom dark)
- Speaking ring depends on LiveKit `participant.isSpeaking` (subtle when audio levels are low)
- No dedicated Toast system yet (inline errors / confirm() for end-class)
- Favicon unchanged

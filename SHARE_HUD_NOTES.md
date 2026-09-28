# Share HUD — teach while screen sharing

Compact **teacher-only** floating control bar while the teacher is screen sharing.
Students never see this chrome — only the shared screen + annotations.

## What changed (2026-09-28)

| Issue | Root cause | Fix |
|---|---|---|
| First click opened controls, second click started share | Document PiP / `window.open` consumed the user gesture before `getDisplayMedia` | Start share **first**, then show an **inline** compact bar (no second window) |
| Control panel too bulky | Full sheet / 300×420 PiP with always-visible chat | Slim floating bar; chat / hands / roster open from icons only |
| Mobile silent no-op | Share failure swallowed; PiP path useless on mobile | Detect `getDisplayMedia`, show clear tip in the HUD; open bar even when share is blocked |
| Whiteboard vs annotate confusion | Separate whiteboard stage | Whiteboard product surface removed; annotate stays on screen share |

## Files

| File | Role |
|---|---|
| `TeacherShareHud.tsx` | Compact floating bar + expandable chat/hands/roster panels |
| `ScreenAnnotator.tsx` | Annotation overlay + LiveKit transport |
| `ClassroomRoom.tsx` | One-click `toggleScreen`; teacher-only HUD; dock hides chat/roster while sharing |
| `app/api/rooms/[code]/annotate/route.ts` | Redis snapshot for late joiners |

## Browser limits (mobile)

- **iOS Safari / many iPhone browsers:** `getDisplayMedia` is limited or unavailable. The share button opens the teacher HUD with an explanation instead of doing nothing. Prefer sharing from a computer or Android Chrome.
- **Android Chrome:** Screen share usually works; the compact bar stays in-page (no always-on-top when the tab is backgrounded).
- **Desktop Chromium/Firefox/Safari:** One click starts share + shows the bar. Annotate draws on the classroom stage over the shared video.

## How to try

1. Teacher starts class → **Share screen** once.
2. Browser picker appears; after choosing a surface, a slim **Share** bar appears (mic, annotate, chat, hands, roster, stop).
3. Students see only the shared screen (+ annotations when the teacher draws).
4. Closing the bar (✕) does **not** stop sharing — use **Open share controls** or **Stop**.

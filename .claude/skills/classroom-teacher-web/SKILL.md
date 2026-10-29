---
name: classroom-teacher-web
description: Operate the classroom web app as a teacher by driving a browser (Playwright, Chrome automation or computer use) - sign in, start or re-enter a class, admit students, manage mic/camera/noise removal, roster and raised hands, chat, share screen, run the whiteboard, end the class. Use when asked to teach, demo, test or rehearse a class in the web app UI, or to automate a teacher flow there. For teaching through tools without a browser, use the classroom-ai-teacher skill.
---

# Teaching in the classroom web app (browser)

Labels below are the app's own `aria-label`s, button texts and `data-testid`s
(`apps/web/src/components/classroom/`, `apps/web/src/lib/whiteboard/`).
Prefer role + name selectors (`getByRole('button', { name: 'End class' })`)
and the test ids; the layout changes between phone, tablet and desktop.

## Rules that save a class

- **One teacher connection per class.** Opening the same class in a second
  tab, or the Windows/Android app, with the same account disconnects the
  first. Never do it while an AI teacher runs the class on that account.
- Camera, microphone and screen sharing need permission prompts and a real
  click (user gesture). With automation, launch Chromium with
  `--use-fake-ui-for-media-stream` (tests) or click through the prompts.
- Students cannot hear the class until the teacher is connected; they see
  "Waiting for teacher…" until then and "Teacher is in the room" after.

## Sign in and start

1. `/login`: fill `input[name=email]`, `input[name=password]`, click the
   submit button. First sign-in of a new account lands on
   `/account/password` (fields `current`, `new`, `confirm`).
2. `/teacher/dashboard`: the "Now / Next class" card has **Start class** (or
   **Re-enter class** / **Re-enter** when it is running). Timetable rows have
   the same buttons. Ad-hoc: the form with **Campus**, grade, **Divisions**,
   **Subject / title** and **Start extra class**.
3. The class opens at `/classroom/<CODE>`. The teacher dock is
   `[data-testid=teacher-dock]`.

## In class (teacher dock)

| Want | Control |
| --- | --- |
| Microphone | **Unmute microphone** / **Mute microphone** |
| Noise removal | the caret on the mic, **Microphone options** (`[data-testid=mic-options]`): radio **Standard / Enhanced / Strong**, checkbox **Voice focus**; status line `[data-testid=mic-options-status]` |
| Camera | **Turn camera on** / **Turn camera off** (starts off) |
| Share screen | **Share screen** / **Stop sharing screen**; controls pop out in a small window (or the in-tab dock `[data-testid=share-inline-dock]`) |
| Whiteboard | **Share a whiteboard (students see it live)** / **Stop whiteboard sharing** |
| People | **Open roster** (shows "(n raised hands)"); search **Search students**; long lists show **Show N more** (`[data-testid=roster-more]`) |
| Admit | **Admit all (n)** in the waiting banner, or **Admit** per student in the roster |
| Raised hands | toast `[data-testid=raised-hands-toast]` with **Let <name> speak** (unmutes and lowers the hand) |
| Chat | **Open chat**; **Send to** (everyone, or one student for a private reply); **Chat message**, **Send message** |
| Everyone quiet | **Mute all** / **Unmute all** |
| Videos | **Video panel** (`[data-testid=video-panel]`), **Rotate video sample** |
| Leave (only you) | **Leave class** |
| End for everyone | **End class**, then the dialog `[data-testid=end-class-confirm]` -> **End class** (or **Cancel**); the summary is `[data-testid=class-summary]` |

## Whiteboard

The board fills the screen (`[data-testid=wb-host]`); the meeting bar on the
right (`[data-testid=meeting-bar]`) keeps mic, camera, chat, people, admit,
student drawing (`wbm-draw-allow` / `wbm-draw-deny`), **Stop whiteboard**
(`wbm-stop`) and **End class** (`wbm-end`).

Left tool column (groups open a flyout):

| Group | Tools |
| --- | --- |
| **Select** (V) | tap/drag to select; move, resize handle; selection bar `[data-testid=wb-selection-bar]` with **Duplicate selection**, **Delete selection** |
| **Draw: pen, highlighter, text** (P / H / T) | text tool places a box (`[data-testid=wb-text]`); hold still at the end of a stroke to snap it to a clean shape |
| Laser (L) | fading pointer, not saved |
| **Shapes: line, arrow, rectangle, ellipse, triangle** | **Fill shapes** toggle |
| **Erase** (E) | eraser, area eraser, **Clear page** |
| **Colour and size** | palette, **Thickness** |
| **Undo (Ctrl+Z)**, **Redo (Ctrl+Y)** | |
| **Pages and background** | **Previous page** (PgUp), **Next page** (PgDn), **New page**, **Background**: white, grid, lined, dots, graph, black |
| **Zoom, pan, image and export** | hand, **Zoom in** / **Zoom out** (Ctrl+wheel), **Fit page**, **Insert image**, **Export PNG**, **Export PDF** |

Page coordinates are 1920 x 1080 whatever the screen size; students see the
same page scaled.

## Checking what students see

Open a student with a signed school-app link (`apps/web/scripts/make-join-link.mjs`)
in a second browser context. "Teacher is in the room" confirms presence; the
board and shared screen fill the student stage; "Your teacher has ended this
class" and the star rating follow **End class**.

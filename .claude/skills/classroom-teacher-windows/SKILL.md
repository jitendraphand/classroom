---
name: classroom-teacher-windows
description: Operate the Windows teacher app (Classroom Teacher, Electron; the windows branch) as a teacher with computer use or UI automation - sign in, start or re-enter a class, admit students, mic/camera/devices and noise removal, share a screen, window or region, annotate, whiteboard, chat and roster panels, student videos, end the class. Use when asked to teach, demo, test or rehearse a class in the Windows app, or to explain where a teacher control is in it.
---

# Teaching in the Windows teacher app

The app is a desktop window plus small always-on-top windows (share
toolbar, tools, panels, student videos). Labels below are the app's own
`aria-label`s / titles (`src/renderer/` on the `windows` branch). With
computer use, read the screen before each click: windows move, and some
controls only appear while sharing.

## Rules that save a class

- **One teacher connection per class.** Opening the same class in the web
  app or another device with the same account disconnects this app (and
  vice versa). Never do it while an AI teacher runs the class on that account.
- Screen sharing picks a screen, window or region in the app's own picker;
  Windows may show its own privacy prompts the first time.
- Global shortcuts work from any app while a class is open:
  **Ctrl+Alt+Shift+M** microphone, **Ctrl+Alt+Shift+V** camera,
  **Ctrl+Alt+Shift+S** stop sharing.

## Sign in and start

1. First screen: **Server** (the school's address), email, password,
   **Sign in**. A new account must change its password first (**Change
   password**).
2. Dashboard: today's timetable; each of your classes has **Start class**
   (or **Re-enter** while it runs; past classes have no button). Below it,
   the ad-hoc form ends with **Start ad-hoc class**. A running class shows
   **Rejoin live class** at the top. **Log out** is at the top right.

## In class (main window)

| Want | Control |
| --- | --- |
| Microphone | **Mute microphone** / **Unmute microphone** |
| Camera | **Turn camera off** / **Turn camera on** |
| Devices and noise removal | **Microphone, camera and noise removal** (caption *Devices*): pick the microphone and camera; **Noise removal** (Standard / Enhanced / Strong); **Voice focus**; the line under it says what is running now |
| Share | **Share screen**; while sharing, **Stop sharing screen** |
| Whiteboard | **Share a whiteboard (students see it live)** / **Stop whiteboard sharing** |
| Chat / roster | **Open chat**, **Open roster** ("(n raised hands)" when hands are up) |
| Videos layout | **Show 2 / 4 / 6 videos, including you** |
| Everyone quiet | **Mute all** / **Unmute all** |
| Leave (class keeps running) | **Leave class (it keeps running for the students)** |
| End for everyone | **End class** (hidden while sharing: stop sharing first) |

## While sharing (floating windows)

- **Share tools** bar: **Mute mic** / **Unmute mic**, **Turn camera
  off/on**, **Show student videos** / **Close student videos window**,
  **Video mode (smooth playback)** for video, **Low power mode**, **Send
  computer sound**, **Chat**, **Raised hands**, the admit button (**Admit
  everyone waiting**), **Annotate** / **Stop annotating**, **Share screen**
  (switch source), **Stop sharing**.
- The share picker has **Screens**, **Windows** and **Region** tabs, then
  **Share** (or **Close**).
- Tools window groups (each opens a row): drawing (**Draw: pen,
  highlighter, shapes, text**, **Colour and size**, **Thickness**, **Pick
  any colour**), **Erase and undo**, the **Meeting** group (mic, camera,
  **Microphone, camera and noise removal**, **Chat**, **Raised hands**,
  **People**, **Admit all n waiting**, **Student videos**) and **Share:
  stop, video or slides mode, computer sound**.
- Panels (Chat, Roster, Devices) are separate small windows with a close
  button; the roster has **Search students**, raised hands first, and
  **Show N more** for big classes; **Unmute and lower the hand** lets a
  student speak.

## Whiteboard

Same board as the web app (page 1920 x 1080): a left tool column (select,
draw, laser, shapes, erase, colour, undo, redo, pages, view/zoom/export)
and a meeting column on the right with mic, camera, **Chat (reply to
students)**, people, admit, student drawing, **Stop whiteboard sharing**
and **End class**. Keyboard: V select, P pen, H highlighter, L laser, E
eraser, T text, Ctrl+Z / Ctrl+Y, Delete, Ctrl+D duplicate.

## Ending

Stop sharing, say goodbye, **End class** and confirm. The dashboard returns
with the class marked held; students see "Your teacher has ended this class".

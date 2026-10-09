# Extensive live-class UX review (chat, video panel, share, annotate)

Run an automated, headed/headless Chromium Playwright class against the live deployment https://13-201-89-150.sslip.io (source: /workspace/classroom). Emulate every device carefully. Be honest that these are emulated Chromium clients, not real iOS WebKit or real Android Chrome hardware, and list what emulation cannot prove.

## Participants (11 browsers)
- **Teacher:** Windows Desktop Chrome (Windows UA + desktop viewport). Sign in as jitendraphand@gmail.com / password from env CLASSROOM_TEACHER_PASSWORD (set it locally from the known teacher password; never print or commit it). Permanent class code **S3TDTK**. One teacher session only — this will sign the real teacher out; that is accepted.
- **2× Windows Chrome desktop students:** TEST-REV-WD1, TEST-REV-WD2
- **2× Android Chrome phones:** TEST-REV-AP1, TEST-REV-AP2 (Pixel 7 / similar portrait + landscape)
- **2× Android Chrome tablets:** TEST-REV-AT1, TEST-REV-AT2 (e.g. Pixel Tablet / Nest Hub Max–class tablet viewport, landscape primary)
- **2× iOS Chrome iPhones:** TEST-REV-IP1, TEST-REV-IP2 (iPhone 14 / 15 CriOS UA, portrait + landscape)
- **2× iOS Chrome iPads:** TEST-REV-ID1, TEST-REV-ID2 (iPad Pro–class CriOS UA, landscape + portrait)

Students join via unsigned school link:
`/join?FirstName=…&LastName=Rev&SID=TEST-REV-…&Grade=9&Division=<existing division, e.g. Alpha>`
Use fake media (--use-fake-device-for-media-stream, --use-fake-ui-for-media-stream, Y4M/WAV) so camera, mic and screen produce real tracks. Do **not** change server code, .env or the deployment. Do **not** touch real students (GOS* etc.) or delete anything except the TEST-REV-* rows you create (cleanup at end if possible).

## Focus of this review (the product questions to answer in depth)

### A. Chat / messaging
1. **Message strings:** every visible string teachers and students see in chat (placeholders, empty state, “Everyone”, DM labels, timestamps, send button, errors, unread badges). Quote exact copy.
2. **Teacher sees everyone’s messages:** how the teacher roster/chat lists broadcast vs DM; does the teacher see all student→teacher and student→Everyone messages? Screenshots of the teacher chat with a mixed thread of Everyone + several DMs.
3. **Teacher reply to a particular message / student:** how does the teacher start a reply to one student (tap a message? pick from roster? “Reply” control?)? Document the exact steps and UI. Can the teacher switch between “Everyone” and a named student easily?
4. **Convenience of responding:** time/clicks to (a) reply to one specific student, (b) reply to everyone. Friction: keyboard, mobile tap targets, whether the recipient sticks after send, whether unread/hand context is visible while composing.
5. **Student view of chat on every device type:** open chat before share, during share, and during annotate. Screenshot each device family. Note: panel vs sheet vs full-screen overlay; how much of the stage it covers; whether new messages are readable while the share is on screen.

### B. Screen share + annotation
6. Start a whole-tab (or whole-screen) share from the teacher Windows Chrome UI. Prefer a tab that plays a short video/audio so share-audio can be checked.
7. **Student floating teacher video panel:** on EVERY device type (Windows desktop, Android phone, Android tablet, iPhone, iPad), does the student see the floating/draggable teacher video (and self-view if any)? Can it be moved / minimized? Screenshot each. Say clearly if any device family lacks it.
8. **While screen is shared:** what students see (share stage, floating video, own controls). Coverage % of own UI over the share, per device, portrait and landscape for phones/tablets.
9. **When screen is annotated (teacher Annotate on):** freeze/still behaviour if any; do students see strokes in the correct place on every device size? Timing of stroke delivery. Screenshot after a deliberate drawing (a large X and a circle).
10. **Can a student annotate?** Try to find any student annotate/draw control. If none exists, state clearly that student annotation is not available (teacher-only by design). Do not invent a feature.

### C. Teacher video panel (student cameras)
11. **Changing how many students appear:** document the 2 / 4 / 6 controls exactly (labels, where they live). Switch through each; screenshot. Confirm “Show N” counts teacher + students or students only.
12. **Do they change on their own?** Observe automatic rotation (~8 s) with >6 publishing cameras. Record which faces appear over ~40 s. Speaker priority if audible.
13. **Pinning:** pin from roster and from a tile (if present). Confirm the pin holds through rotation. Unpin. Hit pins_full if possible. Screenshot pinned state on teacher UI.

### D. Hand raise
14. Have several students raise hands at staggered times across device types. Document: ✋ icon placement, sort-to-top (earliest first), teacher toast/badge, how the teacher lowers a hand / responds, whether raise is visible while the teacher is in chat or sharing.

### E. Cross-cutting UX notes
15. Waiting room on → admit one → admit all; then waiting room off → one late join (direct entry).
16. Default mute; unmute one; Mute all / Unmute all labels on each student device.
17. Students must **never** receive other students’ video (check subscriptions).
18. End class; note where each student lands (especially school-app Home → should be `/student`).

## Measure
- Join time, chat delivery latency (Everyone + DM), hand-raise latency, annotate stroke latency.
- getStats on share: resolution, fps, bitrate, presence of screen_share_audio.
- CPU/RSS of the Chrome tree if easy.

## Output
Write everything under `/workspace/windows/ux-review/`:
- **REPORT.md** — answer each numbered product question above with findings, pass/fail, exact UI copy, severity-ranked bugs, and per-device screenshots (paths relative to this folder).
- Scripts so the run is repeatable.
- A short **EXECUTIVE.md** (≤1 page) aimed at the product owner: what works, what’s awkward, what’s broken, recommended next UX fixes for chat reply convenience and student overlays.

## Cleanup
End the class. Delete only TEST-REV-* students and their attendance/session rows if the admin/API allows; otherwise list them for later cleanup. Close all browsers. Do **not** fix product bugs in this run — report only.

Start now. Prefer automating with Playwright scripts under `/workspace/windows/ux-review/` rather than one-off manual clicks, so results are reproducible.

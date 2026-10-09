# UX review — for the product owner

One live class, 5 Oct 2026, 15:41–15:46 UTC, room S3TDTK, subject “REV ux”. Ten TEST-REV students on emulated Windows, Android phone, Android tablet, iPhone, and iPad Chromium — not real WebKit or real devices. The class is ended. Timings and screenshots are in `REPORT.md`.

## What works

Students land in this teacher’s class (9-ALPHA) from the signed school link. The lobby names them. “Admit WD1 R.” admits one; Admit all took the other eight, already muted. With the waiting room off, the late iPad entered directly, and the room was turned back on so a real student would not follow. End class sends all ten to `/student`.

The teacher sees every broadcast, direct, and student→teacher note. A student sees only broadcasts, their own notes, and directs to them. Unread is a “1” on the chat button. Delivery was under a second. Hands arrive in about 370–400 ms, sort earliest-first, and can be lowered by name. During a share they are a list with Lower on each row.

Every family gets a draggable float (teacher camera and self-view) that minimizes to “Show videos”. Students receive the teacher’s camera and screen, and not each other’s cameras. Annotate on an entire-screen share froze the frame; an X and a centre loop arrived at the same coordinates on every measured screen. Students have no draw tool.

## What’s awkward

A private reply is the To menu, not a tap on the message, and To jumps back to Everyone after every direct. The next private line means picking the name again. Opening chat closes the roster, so raised hands disappear while the teacher is composing. During a share, hands and chat sit together only inside Share controls.

On a phone, chat covers about half the portrait screen (48%). With the control bar, portrait overlay is about 60%. Landscape chat is still about 40%. The drawing sits under that sheet. Tablets and iPads stay near 13% because anything wider than 640 px gets the small desktop panel.

The digits 2, 4, and 6 do not match the header. The room started at “6/6 videos shown”. Pressing 6 changed it to “5/5”. Pressing 2 left the teacher plus one student visible and printed “1/1 videos shown”.

The full-screen card still says to share a window or a tab in order to draw, while Annotate is on and freeze-draw works. The on-screen float is removed (“could not be tracked”) and rebuilt inside the classroom tab — the window the teacher was told to minimise. Pen and hands live in that tab, not on the display the class is watching.

## What’s broken

Admit, chat privacy, mute, hands, share, annotate, and leave all completed for these ten students.

Pin did not. The tile button is real (“Pin ID2 Rev (keep in the panel)”), and the click never landed because that student was not on screen. Hold through rotation, unpin, and a full slot were not measured. This is a gap in the review, not a shown product failure. It was not retried: a Physics period was still telling `/student` visitors they would enter automatically.

## Do these next

1. Keep the private recipient after send, and add Reply on a student message.
2. Show who has a hand raised on the chat header while the roster is closed.
3. On phones, use a short chat sheet so the share and the drawing stay visible. The tablet’s ~13% is the right neighbourhood; 60% is not.
4. Make 2 / 4 / 6 and “videos shown” the same count, teacher tile included in whichever count you keep.
5. Rewrite the entire-screen card so it matches freeze-draw, and keep Annotate and Raised hands visible while the teacher looks at the shared display.

TEST-REV-WD1, WD2, AP1, AP2, AT1, AT2, IP1, IP2, ID1, and ID2 (Rev, grade 9, Alpha) were not deleted: the admin student list returned 401. Names for manual cleanup, plus the earlier untouched TEST-SIM rows, are in `REPORT.md`.

# Whole-class simulation on the REAL deployment

Run a realistic, automated UI test of the classroom app against the live server https://13-201-89-150.sslip.io (source: /workspace/classroom; Windows app: /workspace/windows). Use Playwright with headed or headless Chromium on this Linux machine. Simulate each device with Playwright device emulation and matching user agents and viewports: Desktop Chrome on Windows, iPhone with iOS Chrome (CriOS UA, WebKit-like behaviour where possible), and Android Chrome (e.g. Pixel 7). Use fake media (--use-fake-device-for-media-stream, --use-fake-ui-for-media-stream, and a Y4M/WAV file for camera, mic and screen) so cameras, mics and screen share produce real tracks. Be honest in the report that these are emulated devices, not real iPhones or Android phones, and list what emulation cannot prove (e.g. iOS Safari/WebKit fullscreen limits, real touch, real GPU).

## Accounts and rules
- Teacher: sign in as jitendraphand@gmail.com / Rediff@123 (permanent class code S3TDTK) in a Windows-Chrome-emulated browser. Never print or commit the password; read it from an env var you set locally.
- This app allows ONE active session per teacher, so logging in will sign the user's own teacher session out. That is accepted for this test.
- Students join through the unsigned school link: /join?FirstName=…&LastName=…&SID=…&Grade=9&Division=<one of the existing divisions> (check the admin-configured divisions in the source/API, e.g. Alpha, Beta, Gamma). Use clearly fake students with SID prefix TEST-SIM- and last name "Sim", e.g. TEST-SIM-W1, TEST-SIM-W2 (Windows Chrome), TEST-SIM-I1, TEST-SIM-I2 (iOS Chrome), TEST-SIM-A1, TEST-SIM-A2 (Android Chrome). Make sure they land in the teacher's class (Class 9, all divisions, ad-hoc or timetable start as appropriate).
- Do not change server code, the .env or the deployment. Do not touch the 5 real students or other real data.

## Scenario (in order, timestamp every step)
1. Teacher signs in and starts the class from the web dashboard. Check: students are muted by default, the waiting room is ON.
2. 4 students join (W1, W2, I1, A1) and land in the waiting room. Teacher admits one individually, then uses Admit all.
3. Chat: teacher broadcasts to Everyone. Teacher sends a DM to one student. Students reply. Do at least 6 messages total. Verify each student receives exactly the right messages (DM only to its target) and how they appear on each device layout. Measure delivery latency.
4. Hand raise: 2 students raise hands at different times. Verify the ✋ icon before the name and sort-to-top order (earliest first) in the teacher roster. The teacher lowers a hand.
5. The teacher turns the waiting room OFF ("Direct entry"). A student joins mid-class (I2, then A2) and must enter directly, muted.
6. Mic: the teacher unmutes one student, Allow unmute, Mute all. Verify students hear each other only when allowed (check audio track subscription/levels).
7. Student videos: all students publish fake cameras. On the teacher side verify the video panel with the 2/4/6 layouts, rotation every ~8 s (record which students appear over 40 s), speaker priority, and the max-6 cap. Verify students NEVER see other students' video (check subscriptions on each student page).
8. Pinning: the teacher pins a student from the roster and from a tile. Verify it stays through rotation. Unpin. Try exceeding pins (pins full).
9. Screen share: the teacher shares the whole screen/tab with a fake capture, including audio. Play a test video/audio clip in the shared tab and check whether students receive the screen-share audio track (and whether it is audible: track subscribed, audio level > 0).
10. Annotation: the teacher annotates (pen, eraser, clear, undo). Verify each student receives the strokes overlaid in the right positions on their device size. If the app supports student annotation when permitted, test that too; if it does not exist, say so clearly.
11. Student view per device: take full-page screenshots on every student device during the share. Measure what fraction of the teacher's shared screen is blacked out (the teacher toolbar/panel mask) and what fraction of the student's own viewport is covered by the student's own controls/overlays/floating teacher video. Report the percentages per device, portrait and landscape for phones.
12. Fullscreen enforcement: a student exits fullscreen or switches away. Check the teacher's indicator and the student's cover.
13. Other features: roster chips, "N not in fullscreen", Copy invite link, device switch is optional, Leave/rejoin of one student, then End class. Check that students see "Class ended" and land in the right place.

## Measure throughout
CPU (per browser process), network up/down per client (from WebRTC getStats: bitrate, resolution, fps, which simulcast layer is received), join time, and message/mute/hand latency.

## Output
Write everything to /workspace/windows/e2e-sim/:
- REPORT.md: a step-by-step pass/fail table, screenshots per device per step, the blackout and overlay percentages, audio findings, getStats summaries, bugs found ranked by severity with repro steps, and UX observations per device.
- The test scripts, so the run can be repeated.

## Cleanup
At the end:
- End the class.
- Delete ONLY the TEST-SIM- students and the attendance/session rows created by this test, if the admin UI/API offers that. Otherwise list them for manual cleanup.
- Don't leave any browsers running.

Do not fix bugs in this run; just report them.

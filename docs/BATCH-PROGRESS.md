# Web batch progress (on top of 673b46b)

Baseline (673b46b, local LiveKit 1.13.9, 1 teacher + 4 students (2 phone-emulated), 60 s):
- /classroom/[code] first load 309 kB (shared 103 kB)
- student /api 4 req/min, teacher 6 req/min; DB xacts 24/min per client (pg_stat_database)
- phones receive the share at 1920x1080 VP9 (item 3 broken)
- after end: 0 requests in 30 s (leave → navigates to /student home)

Done:
- shared pure modules: lib/deviceTakeover, classFinish, eraseBatch, subscriberCodecs, reconnectQuality; lib/subscriberCodecPatch (browser)
- takeover server: lib/deviceTakeoverServer, studentService.ensureStudentParticipant rotates token on second device; redis keys replacedToken/takeovers
- SHARE_CODEC backup → h264

TODO: state route (replaced/meLeft/takeovers + cache), client finish screen, teacher toast, draw batch, Caddy, Redis cache, TURN, codec patch wiring, lazy load, reconnect, tests, measure, deploy
- [x] state route: replaced/meLeft/takeovers; dbCache (versioned, bump on every Prisma write) on room/teacher/student-token/classSession/attendance
- [x] draw route batch erase ids[] + drawServer.deleteStrokes
- [x] client: StudentFinished static screen (left/ended/removed/replaced), window.close, CLASS_FINISHED_EVENT stops StaffSessionGuard; teacher takeover toast; student leave → static screen
- [x] chat UI lazy (chatThread.ts hook split; ChatView next/dynamic); drawing NOT split (provider needed)
- [x] subscriber codec decision before /token (decideSubscriberCodecs); TeacherMediaDemand: small-screen share LOW cap + reconnect step-up
- [x] Caddyfile template + configure-domain-tls.sh: zstd gzip, immutable /_next/static, 1d assets, no-store API
- [x] TURN: compose mounts caddy_data into livekit; example yaml documents turn block (5349 TLS + 3478 udp) — server livekit.yaml to be edited at deploy
- [x] tests/webBatch5.test.ts; all 251 pass; build OK (/classroom first load 310 kB vs 309 kB before)
- [ ] local measure after (measure2.cjs ENDWAIT=120), takeover script, commit/push, deploy (+server Caddyfile & livekit.yaml turn), TURN relay check
- [x] idle logout auth poll stops on CLASS_FINISHED_EVENT (first after-run showed 2× /api/auth/me per 2 min)
- [!] item 3/8 codec: decline-VP9 + H.264/VP8 backup tried (single+dual PC): LiveKit never started the backup → phone got NO share. Reverted (backup stays vp8, patch removed). Phones keep VP9 1080p single layer; small-screen explicit setVideoDimensions(1280x720) kept (effective for VP8-simulcast publishers).
- DB xacts per client per min: 24 → 11 (after5 run)
- [x] student Leave shows "You left" (finish before /leave; keepalive). Final local: 0 requests for 120 s after end/leave; DB 10.8 xacts/min/client; /api 4/min student, 6/min teacher; first load 309 kB
- [ ] commit/push/deploy

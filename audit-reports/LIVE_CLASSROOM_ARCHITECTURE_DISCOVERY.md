# Live Classroom Architecture Discovery

Everything below was verified in code unless it is labelled otherwise. No technology was assumed.

## 1. What powers the live classroom

| Concern | Technology (verified) | Evidence |
|---|---|---|
| Media server | **LiveKit SFU** (selective forwarding; no MCU, no transcoding) | `docker-compose.yml:127` `livekit/livekit-server:v1.13.9` |
| Signaling | LiveKit WebSocket protocol (`ws(s)://…:7880`) through Caddy | `infra/Caddyfile` `livekit.example.com` block |
| Transport | WebRTC: ICE/UDP 50000–60000, ICE-TCP 7881; **no TURN** by default | `infra/livekit.example.yaml:311-325, 387-398` |
| Web client | `livekit-client` 2.22 via `@livekit/components-react` `<LiveKitRoom>` | `ClassroomRoom.tsx:4537-4614` |
| Android teacher | `io.livekit:livekit-android:2.29.0` | `apps/android/app/build.gradle.kts` |
| Windows teacher | `livekit-client` 2.22.3 in the Electron renderer, plus a **Rust livekit 0.9 sidecar** that publishes the screen share as a second participant `teacher_…__screen` | `windows:src/renderer/classSession.ts:471`, `native/share-sidecar/src/main.rs:1-20` |
| Screen capture | Web: `getDisplayMedia`. Android: MediaProjection through LiveKit's ScreenCaptureService. Windows: Windows.Graphics.Capture in `affinity-helper.exe` → RGBA frames → sidecar | `ClassroomRoom.tsx:671`, `AndroidManifest.xml`, `affinity-helper.c` |
| Audio | Opus speech preset, **DTX + RED** on; optional RNNoise/Speex worklet (WASM fetched on demand); Android "VoiceFocus" capture post-processor | `ClassroomRoom.tsx:4564-4571`, `lib/audio/voiceProcessor.ts:263-265`, `VoiceFocus.kt` |
| Chat / control | HTTP API → Postgres/Redis → **server-originated LiveKit data packets** (topics `cls-state`, `chat`, `draw`, `wb`); SSE fallback; slow polls. Students have **no data-publish grant** | `lib/livekit.ts:146-164, 321`, `lib/pollPolicy.ts`, `messages/stream/route.ts` |
| Whiteboard | Vector ops over data packets (teacher) and an API relay (students); no video | `lib/whiteboard/*`, `api/rooms/[code]/whiteboard` |
| Recording | **None** (no Egress client, no MediaRecorder: grep is empty). README: "No recording (by design)" | — |
| Presence / attendance | LiveKit webhooks (`participant_joined/left/connection_aborted`, `room_finished`), signed JWT verified | `api/livekit/webhook/route.ts:149-154` |

## 2. Media paths

```mermaid
flowchart TB
  subgraph Teacher
    TC[Camera 360p15 ≤300 kbps + 180p layer]
    TM[Mic Opus speech, DTX, RED]
    TS[Screen VP9 L2T3_KEY ≤2.5 Mbps / VP8 backup]
  end
  subgraph SFU[LiveKit SFU]
  end
  subgraph Student["Each student (web)"]
    SV[Receives: teacher mic, teacher cam (LOW layer while sharing), share, classmates' mics]
    SP[Publishes: mic (when allowed by grant), camera ONLY if in visible sample ≤6]
  end
  TC --> SFU
  TM --> SFU
  TS --> SFU
  SFU --> SV
  SP --> SFU
  SFU -- "sampled student cams, LOW layer, only tiles shown" --> Teacher
  SFU -- "student mics" --> Teacher
```

| Flow | Path | Control |
|---|---|---|
| Teacher audio → students | Teacher publishes mic → SFU → every student subscribes (`StudentMediaPrivacy.tsx:122-131`) | — |
| Teacher video → students | Teacher camera simulcast (360p + 180p) → SFU forwards the layer the student asks for: LOW while sharing, disabled in "share-only", paused when the float is minimised | `lib/dataSaver.ts:35-45`, `StudentMediaPrivacy.tsx:105-120` |
| Student audio → teacher (and classmates) | Mic publish is allowed by the **grant** only when the student is not teacher-muted and the teacher is present (`lib/livekit.ts:146-156`); mic-slot limit (`micSlotService.ts`) | Server-enforced |
| Student video → teacher | Only students in the Redis **visible sample** (≤6, rotated every 8 s; speakers are pinned for 18 s) get `CAMERA` in their grant (`token/route.ts:72-109`); the camera is sent only while the teacher shows it (`camOnDemand.ts`) | Server-enforced |
| Screen share → participants | Teacher only (the grant has `SCREEN_SHARE` for teachers only) | Server-enforced |
| Chat | `POST /messages` → DB + Redis pub → server `sendData` (reliable) to the audience | `livekit.ts:321` |
| Join/leave | LiveKit webhook → attendance queue; client heartbeat every 40 s (jittered); `disconnectOnPageLeave` for students | `studentPresenceLogic.ts:22` |

**Signaling and media are separate:** HTTP API (port 443/3000) for app state; LiveKit WS (443 through Caddy, or 7880) for signaling; UDP/TCP RTC ports for media.

**Platform differences:** web and Windows use dynacast; Android does not (PERF-03). Windows publishes the share from a separate native participant. Students are always on web.

## 3. Classroom lifecycle (traced)

| # | Step | Implementation | Observations |
|---|---|---|---|
| 1 | Class creation | Teacher's permanent `Room` (fixed code); `POST /api/teacher/sessions/start` creates or reuses the `ClassSession` | Starting another class ends the previous one |
| 2 | Session init | `Room.sessionId` rotates per class; LiveKit room name `classroom_<CODE>_<sessionId>` | Old chat is deleted on reopen (`teacherRoom.ts:193`) |
| 3 | Teacher joins | `GET /token` (teacher) clears cached presence and the stale stage (`token/route.ts:77-86`) | Good: avoids a "stuck screen" stage |
| 4 | Student joins | Link or form → pupil cookie → `/student` routes → `POST /join` → WAITING | Waiting poll 3 s visible / 8 s hidden |
| 5 | Auth/permission | `resolveRoomAccess` (`auth.ts:382-442`); grade-division check; admission | — |
| 6 | Signaling | Token with pacing `connectDelayMs` (join-wave spread) | Prevents connect storms |
| 7 | Media connect | `peerConnectionTimeout 20 s`; on a first-connect failure, retry with a fresh token and backoff | — |
| 8 | A/V transmission | See §2 | — |
| 9 | Screen share | Capture hints, VP9 SVC, video mode toggle | — |
| 10 | Participant join/leave | Webhook + heartbeat + `ParticipantDisconnected` grace | — |
| 11 | Network interruption | LiveKit resume/restart; `ReconnectWatchdog` rejoins if stuck; `reconnectQuality.ts` resumes on low layers for 8 s | — |
| 12 | Reconnection | Jittered exponential `classroomReconnectPolicy()` | — |
| 13 | Termination | `POST /end` (teacher) or admin end → `cls-state` push → clients show the end screen and disconnect | — |
| 14 | Cleanup | LiveKit `empty_timeout 300 s`, `departure_timeout 10 s`; Redis keys TTL; participant rows pruned after 30 days | Chat lingers until the next class (SEC-07) |
| 15 | Attendance | Redis queue → batched DB flush; union of intervals across reconnects and tabs | — |
| 16 | Recording | Not implemented | — |

**Duplicate or unnecessary work found:** teacher `/state` double room read (PERF-06); join-form seeding per request (PERF-07); students decoding video while hidden (DATA-01). I found **no duplicate media connections** in the web client: one `Room` per mount, and `key={connKey}` forces a clean remount on rejoin.

## 4. Alternatives considered

| Option | Student data | Student CPU | Server cost | Latency | Verdict |
|---|---|---|---|---|---|
| **Current: SFU + selective publish + simulcast/SVC** | Low: only what is shown | Low: ≤2 video decodes | Egress-bound, linear in students | ~150–400 ms | **Keep** |
| P2P mesh | O(N) uploads per peer | Very high | Lowest server cost | Low | Unusable above ~4 people |
| MCU (server compositing) | Single stream | Lowest decode | **Very high server CPU** (decode + encode per layout) | +100–300 ms | Not justified: students already get ≤2 streams |
| RTMP ingest → HLS/LL-HLS (CDN) | Comparable or lower (ABR ladders, CDN caching) | Low | Cheap at huge scale through a CDN; needs transcoding | **3–10 s** (LL-HLS ~2–4 s) | Breaks interactivity (hands, unmute, drawing). Consider only as an *overflow* or "view-only" mode for 1,000+ audiences |
| Hybrid: SFU for interactive seats + HLS for passive viewers | Lower for passive viewers | Low | Shifts egress to a CDN | Mixed | Worth evaluating **only** if a single class exceeds one node's egress; not needed for typical class sizes |
| AV1 for the share | −20–30% bits | Higher encode CPU; decode support patchy (iOS) | Same | Same | Repo already declined it (docs/BANDWIDTH.md); I agree |
| Audio-first "low-data" mode | **−85–95%** | Lowest | Lower egress | Same | **Add** (DATA-02) |

No technology switch is recommended. The worthwhile changes are behavioural, inside the current architecture: background pause, audio-only mode, TURN, and Android dynacast.

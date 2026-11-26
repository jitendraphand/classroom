# Live Classroom Performance and Scalability

All per-size figures are **inferred from code** (what is published and subscribed) with bitrates **estimated** from encoder caps. Repo load-test numbers are cited with their source. Nothing in this file was measured in this audit (see PERFORMANCE_BENCHMARKS.md §3).

## 1. Stream counts by class size (teacher on web, slides share on, all students' cameras on)

Rules from code: ≤6 student cameras in the visible sample (`MAX_VISIBLE_STUDENT_VIDEOS`, hard max 6); a student camera is published only while the teacher shows it (`camOnDemand.ts`); the teacher subscribes only to the shown tiles at LOW (`TeacherPeersFloat.tsx:660-703`); students subscribe to teacher tracks plus every classmate mic (`StudentMediaPrivacy.tsx`).

| Students | Published video tracks (SFU ingress) | Video decoded per student | Video decoded by teacher | Audio subscriptions per student | Rendered tiles (student) |
|---|---|---|---|---|---|
| 1 | 2 (teacher cam, share) + ≤1 | 2 (share + small cam) | ≤1 | 1 + 0 | 2 |
| 2 | 2 + ≤2 | 2 | ≤2 | 1 + 1 | 2 |
| 5 | 2 + ≤5 | 2 | ≤5 (shown tiles) | 1 + 4 | 2 |
| 10 | 2 + ≤6 | 2 | ≤6 | 1 + 9 | 2 |
| 25 | 2 + ≤6 | 2 | ≤6 | 1 + 24 | 2 |
| 50 | 2 + ≤6 | 2 | ≤6 | 1 + 49 | 2 |
| 100+ | 2 + ≤6 | 2 | ≤6 | 1 + N−1 | 2 |

**Key property:** a student's decode load is **constant** (2 videos) whatever the class size. Classmates' microphone subscriptions grow with N, but muted or silent (DTX) tracks carry ~0 bytes; only unmuted speakers cost (~24 kbps each). Mic-slot limits cap simultaneous unmuted students (`micSlotService.ts`).

**Unnecessary streams:** none found on the student side while the tab is visible. While hidden, video continues (DATA-01).

## 2. Bandwidth per student and server egress (estimate)

| Content | Per student | 50 students | 200 students | 1,000 students |
|---|---|---|---|---|
| Audio + whiteboard | 0.1–0.15 Mbps | 5–7.5 Mbps | 20–30 Mbps | 100–150 Mbps |
| Slides + camera (60% phones) | ~0.6 Mbps avg | ~30 Mbps | ~120 Mbps | ~600 Mbps |
| Video mode | 1.1–1.6 Mbps | 55–80 Mbps | 220–320 Mbps | 1.1–1.6 Gbps |

SFU ingress is small (teacher ≤3 Mbps plus ≤6 × 0.2 Mbps student cameras). **Egress is the cost and capacity driver.** The repo's own planning figure is ~200 students per 200 Mbps media node (`docs/BANDWIDTH.md`).

## 3. Server CPU/RAM (from repo load tests; not re-measured)
- LiveKit ≈ 4.1 cores at ≈ 410 connections (`docs/CAPACITY.md:17`), i.e. **≈ 1 core per 100 participants** for forwarding (SRTP encryption per subscriber dominates).
- During the join ramp, LiveKit reached 16–22 cores at 1,200–1,500 students (`docs/SCALING.md:45`): connection set-up (DTLS/ICE) is the spike. Join pacing exists for this reason.
- Web tier: `/state` was the 503 hotspot at 1,500 students before the cache and nudge work (`docs/SCALING.md:3`).

## 4. Latency, jitter, packet loss, reconnection
Not measured. Code-level expectations: SFU forwarding adds tens of ms; with no TURN, path latency equals direct. Reconnection: LiveKit resume in seconds; `ReconnectWatchdog` forces a rejoin when stuck; join pacing can delay a mass reconnect by up to `joinSpreadForRoom` (it grows with room size).

## 5. Recommendations (in the existing architecture)
1. **DATA-01 / DATA-02:** they directly lower egress per disengaged or weak-link student.
2. **Speaker-based video:** already done (speaker pins). Keep it.
3. **Audio prioritisation:** keep RED. Consider `AudioPresets.speech` → 24 kbps mono for students in data-saver modes (currently a single preset).
4. **Simulcast/SVC:** already present. For the **teacher camera**, a third very-low layer (160×90 @ 8 fps, ~40 kbps) would serve "Audio + slide" users who still want a face. Optional.
5. **Measure before claiming capacity:** run `scripts/loadtest` with the harness in PERFORMANCE_BENCHMARKS.md at 25/50/100/200/500 students and record egress per student, LiveKit CPU and RSS, p95 `/state` latency, and connect time.
6. **Multi-node:** already supported (`docs/MULTI-SERVER.md`, `lib/mediaServers.ts`). Its routing is per room, so a single class larger than one node's egress is still bounded. That is acceptable for school-sized classes.

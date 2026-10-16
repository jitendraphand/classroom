# Bandwidth per student (2026-10-16)

Goal: 1.5-2x more students per media server. The limit is egress (~200 Mbps
per VM), so the SFU's outgoing bitrate per student is what counts.

## What each student receives

| Stream | Before | Now | Notes |
|---|---|---|---|
| Screen share, Slides, big screen | 0.5-1.5 Mbps (1080p VP9, 8 fps) | same | static slides cost ~0; typing/scrolling peaks |
| Screen share, Slides, phone / small viewport | the same 1080p layer (~0.5-1.5 Mbps) | **~0.3-0.45 Mbps** | VP9 `L2T3_KEY` half-resolution spatial layer; VP8 fallback 720p layer capped at 450 kbps. Chosen by viewport (adaptiveStream, pixelDensity 1 on phones) |
| Screen share, Video mode | up to 1.5 Mbps | up to 1.5 Mbps (phones ~1 Mbps low layer) | teacher choice |
| Teacher camera, no share | ~190-300 kbps (360p) | same | |
| Teacher camera while sharing | ~190-300 kbps | **~60-90 kbps** | new 180p simulcast layer; students request LOW while a share is active |
| Classmate microphones | Opus speech, DTX | same | mono, ~24 kbps while talking, ~0 when silent (DTX) |
| Teacher microphone | ~32 kbps | same | |
| Whiteboard (new) | n/a | **~0-5 kbps** | vector ops over data channels only when something changes; no video |

Teacher side (not per student): student cameras are now subscribed only while
their tile is visible and the panel is open, at the lowest layer; dynacast
stops encoding layers nobody receives everywhere.

## Expected per-student egress
- Phone, slides + teacher camera small: **~0.35-0.55 Mbps** (was ~0.8-1.5)
- Laptop/tablet, slides + camera small: **~0.6-0.9 Mbps** (was ~0.8-1.8)
- Whiteboard lesson: **~0.1-0.15 Mbps** (teacher camera + audio only)
- Video mode: ~1.1-1.6 Mbps (unchanged; avoid for big classes)

Mixed class (60% phones): **~0.6 Mbps average** → about **250-330 students per
200 Mbps node** at full use, so plan **~200 per node** with headroom (the run-4
measured ceiling with the old bitrates was ~150-200 on a 200 Mbps VM: about
1.5-2x). These are estimates from the encoder caps; a new load test should
confirm them.

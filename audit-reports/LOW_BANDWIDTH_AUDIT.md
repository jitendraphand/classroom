# Low-Bandwidth and Low-Data Audit

## 1. What already works well (verified)
- **Push instead of poll.** The server sends tiny `cls-state` nudges; HTTP polls are 60 s safety nets while connected (120 s hidden). Without a live connection they are 5 s (students) or 2 s (teacher) (`lib/pollPolicy.ts`).
- **Jitter and spread** on every poll and nudge (`jitterMs`, `NUDGE_SPREAD_MS = 3000`), so a class does not stampede after a change.
- **Selective subscription.** Students never auto-subscribe; they receive teacher tracks plus classmates' mics only (`StudentMediaPrivacy.tsx`).
- **Codec choices.** Opus with **DTX** (silence ≈ 0 kbps) and **RED** (packet-loss resilience); VP9 SVC share where the subscriber layer follows the viewport (`pixelDensity: 1` on phones); teacher camera drops to its 180p layer while sharing.
- **Data saver** (`lib/dataSaver.ts`): Full / Low / Audio + share; a minimised teacher float pauses the camera.
- **MEDIA_PROFILE=low** deployment switch: roughly halves every bitrate.
- **Smart reconnect:** after a network change the student resumes on low layers for 8 s (`lib/reconnectQuality.ts`).
- **Static assets** are immutable-cached for a year; warm navigations cost **8 KiB** (measured).

## 2. Gaps

| ID | Gap | Impact |
|---|---|---|
| DATA-01 | Video keeps flowing in background tabs (`pauseVideoInBackground: false`) | Up to 0.3–1.5 Mbps wasted per disengaged student (estimate) |
| DATA-02 | No audio-only mode; no `saveData` / `effectiveType` / Poor-quality auto-downgrade | The heaviest stream cannot be dropped by the people who most need to |
| REL-01 | No TURN/TLS on 443 | Students on restricted networks get *no* media |
| PERF-02 | 80 KiB of fonts on first visit | 36% of first-visit bytes |
| PERF-01 | 365 KiB gzip classroom JS, partly teacher-only | Re-downloaded after every deploy |
| UX-01 | No visible network-quality signal for students | Students cannot tell "my network" from "the class is broken" |

## 3. Data per activity (student, web)

| Activity | Value | Label |
|---|---|---|
| App launch / home, first visit | 221 KiB | **Measured** |
| Any page, warm cache | ~8 KiB | **Measured** |
| Dashboard (`/student`) first visit | ~109 KiB gzip JS + shared CSS/fonts (≈ 230 KiB) | Measured JS; total estimated |
| Joining a classroom (first time after a deploy) | ~365 KiB gzip JS + token/state ≈ 0.4 MB | Measured JS; rest estimated |
| 30-min class, slides share, phone | 80–125 MB | Estimated (0.35–0.55 Mbps) |
| 60-min class, slides share, phone | 160–250 MB | Estimated |
| 60-min class, slides share, laptop | 270–400 MB | Estimated (0.6–0.9 Mbps) |
| 2-hour class, slides share, phone | 320–500 MB | Estimated |
| 60-min whiteboard lesson (camera + audio) | 45–70 MB | Estimated (0.1–0.15 Mbps) |
| 60-min "Audio + share", phone | 150–230 MB | Estimated (share dominates) |
| 60-min audio only (**not available today**) | 15–30 MB | Estimated |
| Video-mode share, 60 min | 500–720 MB | Estimated |
| Recording playback | n/a (no recording) | — |
| File downloads | Whiteboard PNG/PDF export only (generated locally) | Inferred |

Network and media settings assumed: Standard `MEDIA_PROFILE`; Chromium subscriber; encoder caps from `videoQuality.ts`; static slides cost far less than these upper ranges.

## 4. Network scenarios (code-level behaviour; not measured)

| Scenario | Expected behaviour today | Risk |
|---|---|---|
| Fast or average broadband | Top share layer, smooth | — |
| Slow broadband (<1 Mbps) | SFU congestion control drops temporal layers (VP9 L2T3 keeps resolution, lowers fps); audio has priority on the bandwidth estimator | Share gets choppy; fine |
| Unstable Wi-Fi | LiveKit resume; RED covers loss; reconnect policy jittered | — |
| 4G | Fine; the phone gets the half-res share layer | Data cost (§3) |
| Congested mobile | Same as slow; no automatic "audio only" offer | DATA-02 |
| High latency (400 ms+) | Works; `peerConnectionTimeout` 20 s | Joins slower |
| Packet loss 5% | Opus RED helps audio; video NACK/PLI | Not measured |
| Temporary disconnection | Resume or rejoin; heartbeat grace before the roster drops the student | — |
| Wi-Fi ↔ mobile switch | ICE restart; `reconnectQuality` steps down then up | — |
| UDP blocked | **Fails** unless TCP 7881 is open; there is no TURN/TLS 443 | REL-01 |

## 5. Proposed intelligent low-data mode
1. **Mode ladder:** Full → Low (current) → Audio + share (current) → **Audio + slide snapshots** (new: subscribe to the share at the lowest temporal layer, or a 1-fps / 15-s still) → **Audio only** (new).
2. **Starting mode** from `navigator.connection.saveData === true` or `effectiveType in ['slow-2g','2g','3g']` → Audio + slide snapshots. Otherwise use the saved choice (current behaviour).
3. **Auto-suggest** after 15 s of local `ConnectionQuality.Poor` or repeated reconnects: a one-tap "Switch to audio only". Never switch silently away from video the teacher is presenting; always offer.
4. **Background:** pause video after 20 s hidden (DATA-01).
5. **Show a data meter** (MB used this class, computed from `getStats` `bytesReceived`). It is cheap, and it builds trust with students on prepaid plans.
6. **Audio first:** keep teacher-mic subscription and RED in every mode. Never drop audio to save video.

Expected effect: a disengaged or poorly connected student falls from 160–250 MB/h to 15–40 MB/h (estimate), which also lowers SFU egress and therefore server cost.

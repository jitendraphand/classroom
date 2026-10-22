# Load test (up to 2,500 simulated students)

Drives the real join → lobby → token → LiveKit connect path. Measures join time and chat / hand / mute-all / whiteboard-data latency (p50/p95).

**Does not contain secrets.** Pass URLs and passwords through the environment.

## Env

| Variable | Required | Meaning |
|---|---|---|
| `LOADTEST_BASE_URL` | yes | App origin, e.g. `http://127.0.0.1:3000` |
| `LOADTEST_CODE` | yes* | Room code. `*` or use `LOADTEST_CODES` |
| `LOADTEST_CODES` | no | Comma-separated codes (many classes) |
| `LOADTEST_COUNT` | no | Students to start (default 50, max 2500) |
| `LOADTEST_CLASSES` | no | Repeat the same code this many times as separate ramps (default 1) |
| `LOADTEST_RAMP_MS` | no | Spread joins over this many ms (default 15000) |
| `LOADTEST_TEACHER_EMAIL` | for admit / mute-all | Teacher login |
| `LOADTEST_TEACHER_PASSWORD` | for admit / mute-all | Teacher login |
| `LOADTEST_LIVEKIT` | no | `1` to connect LiveKit (needs `@livekit/rtc-node`) |
| `LOADTEST_FEATURES` | no | `chat,hand,mute,whiteboard` (default all that credentials allow) |

The server must allow the code+name join path (`ALLOW_MANUAL_STUDENT_JOIN=true`) unless you inject school-app cookies yourself.

## Run

```bash
# HTTP-only (join, lobby, token, chat/hand/mute HTTP). No extra packages.
node scripts/loadtest/loadtest.mjs

# With LiveKit data channels (optional native addon):
cd scripts/loadtest && npm install
LOADTEST_LIVEKIT=1 node loadtest.mjs
```

Example:

```bash
LOADTEST_BASE_URL=https://class.example.com \
LOADTEST_CODE=ABC234 \
LOADTEST_COUNT=250 \
LOADTEST_RAMP_MS=30000 \
LOADTEST_TEACHER_EMAIL=teacher@school \
LOADTEST_TEACHER_PASSWORD=... \
node scripts/loadtest/loadtest.mjs
```

Prints JSON: counts, join p50/p95, feature latencies, errors. Never prints cookies, tokens, or passwords.

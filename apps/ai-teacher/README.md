# AI teacher

Runs a live class as its teacher on the classroom server. Design, capabilities
and safety: [docs/AI_TEACHER.md](../../docs/AI_TEACHER.md).

```
src/
  api.ts       teacher HTTP API client (cookie session, like the Android app)
  live.ts      joins the LiveKit room as the teacher: presence, voice, data, floor
  board.ts     whiteboard host, using apps/web/src/lib/whiteboard (same board as the apps)
  reflex.ts    System 1: chat triage, hands queue, polls, admission, safety, speech chunking
  speech.ts    text-to-speech / speech-to-text over HTTP, voice activity, WAV
  tools.ts     the MCP tools and their guard rails
  control.ts   supervisor control endpoint (pause / resume / stop / status)
  server.ts    MCP server factory
  mcp.ts       MCP server over stdio
  teach.ts     orchestrator: Claude (System 2) + System 1 + streamed voice
```

## Setup

1. An admin creates a teacher account for the AI (e.g. "AI Teacher - Maths"),
   assigns its grades/divisions, and sign in once in a browser to set the
   password (the first sign-in asks for a new one).
2. `cd apps/ai-teacher && npm install` (Node 22+). The board code is imported
   from `apps/web`, so keep this folder inside the repository.
3. Configure the environment:

| Variable | Required | Meaning |
| --- | --- | --- |
| `CLASSROOM_URL` | yes | The school's classroom server, e.g. `https://class.school.example` |
| `CLASSROOM_EMAIL`, `CLASSROOM_PASSWORD` | yes | The AI teacher's account |
| `ANTHROPIC_API_KEY` | for `teach` | Claude API key (or an `ant auth login` profile) |
| `AI_TEACHER_MODEL` | no | Default `claude-opus-5-5` |
| `AI_TEACHER_EFFORT` | no | `medium` (default) explains better; `low` answers faster |
| `AI_TEACHER_PACE_SEC` | no | Move the lesson on after this long without a turn (45) |
| `AI_TEACHER_ADMIT` | no | `roster` (default: signed school-app links), `manual`, `all` |
| `AI_TEACHER_MIN_MINUTES` | no | Refuse to end before this (20) |
| `AI_TEACHER_TTS_URL`, `_KEY`, `_MODEL`, `_VOICE`, `_RATE` | no | Text-to-speech: POST `{model, voice, input, response_format: "pcm"}`, 16-bit mono PCM back (24 kHz default) |
| `AI_TEACHER_STT_URL`, `_KEY`, `_MODEL`, `_LANGUAGE` | no | Speech-to-text: multipart WAV `file` + `model`, `{text}` back |
| `AI_TEACHER_MEDIA_DIR` | no | WAV files `play_audio` may play |
| `AI_TEACHER_ALERT_URL` | no | POSTed a JSON alert on safety escalations |
| `AI_TEACHER_CONTROL_PORT`, `_HOST`, `_TOKEN` | no | Supervisor endpoint (host defaults to 127.0.0.1; token 16+ chars) |
| `AI_TEACHER_ALLOW_LINKS` | no | `1` to allow links in chat/board |
| `AI_TEACHER_AUDIT` | no | Audit log file (`ai-teacher-audit.jsonl`) |

## Run

The orchestrator (Claude teaches; System 1 handles everything else):

```bash
npm run teach -- --plan lesson.md --adhoc MAIN:7:A:Maths --minutes 40
npm run teach -- --plan lesson.md --key "<timetable key>"    # a timetabled class
npm run teach -- --plan lesson.md --code ABC123              # rejoin a running class
```

Or expose the tools to any MCP client (Claude Desktop, Claude Code, an agent
framework) and let it teach:

```bash
npm run --silent mcp
```

`--silent` matters: stdout carries the MCP protocol, and plain `npm run`
prints a banner there.

Claude Code: `claude mcp add classroom -- npm --silent --prefix /path/to/apps/ai-teacher run mcp`
(with the environment above). Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "classroom": {
      "command": "npm",
      "args": ["--silent", "--prefix", "/path/to/apps/ai-teacher", "run", "mcp"],
      "env": { "CLASSROOM_URL": "https://class.school.example", "CLASSROOM_EMAIL": "ai.maths@school.example", "CLASSROOM_PASSWORD": "…" }
    }
  }
}
```

Supervisor, during class (from the machine running it, or wherever the
control host is reachable):

```bash
curl -H "Authorization: Bearer $AI_TEACHER_CONTROL_TOKEN" http://127.0.0.1:$AI_TEACHER_CONTROL_PORT/status
curl -X POST -H "Authorization: Bearer $AI_TEACHER_CONTROL_TOKEN" http://127.0.0.1:$AI_TEACHER_CONTROL_PORT/pause   # or /resume, /stop
```

## Check

```bash
npm run typecheck
npm test
```

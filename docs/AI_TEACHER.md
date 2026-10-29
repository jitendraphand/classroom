# AI teacher

An AI can take a class as its teacher, on the same server, with the same
student apps and the same rules as a human teacher. Students need nothing
new: they join from the school app link as always and see a teacher who
talks, writes on the whiteboard, answers questions, lets them speak, runs
polls and ends the class.

Code: `apps/ai-teacher/` (MCP server, fast rule layer, voice, orchestrator).
Operating playbooks: `.claude/skills/classroom-ai-teacher/` (MCP),
`.claude/skills/classroom-teacher-web/` and
`.claude/skills/classroom-teacher-windows/` (driving the teacher apps' UI).

## Architecture: three layers, one class

```
             students (web on any browser/device, unchanged)
                          |  LiveKit SFU (same room)
  +-----------------------+-------------------------------------------+
  | AI teacher runtime (apps/ai-teacher), joined as the teacher       |
  |                                                                   |
  |  Body      LiveKit participant: presence, voice track, data       |
  |            channel (whiteboard host, chat/hand/state signals)     |
  |  System 1  reflex.ts: every event in microseconds, no model:      |
  |            chat triage, fair hands queue, poll tally, admission,  |
  |            spam, safety escalation, supervisor commands           |
  |  System 2  Claude (teach.ts), woken by System 1 only when         |
  |            something needs judgement or the lesson must move on;  |
  |            acts only through the MCP tools                        |
  |  Voice     say -> sentence chunks -> text-to-speech -> mic track  |
  |            (streamed while Claude is still writing);              |
  |            student given the floor -> VAD -> speech-to-text       |
  +-----------------------+-------------------------------------------+
                          |  HTTPS (teacher API, same as the apps)
               classroom server (unchanged)
```

- **One system.** The AI joins the LiveKit room as the teacher's own
  connection, so the server sees its teacher present (students' mics follow
  the usual teacher-presence rules), and it hosts the whiteboard with the web
  app's own board code (`apps/web/src/lib/whiteboard`), so every student
  client renders it exactly like a human teacher's board, late joiners
  included.
- **System 1 (fast, deterministic).** `src/reflex.ts`. Runs on every event:
  - chat triage: question / greeting / poll answer / unsafe / spam
    (per-student rate), student text truncated and stripped before it can
    reach the model;
  - raised hands: a fair queue (least recently spoken, then longest waiting),
    `nextHand` handed to the model;
  - polls: the latest answer per student, from chat letters or numbers;
  - admission: `roster` (admit students who arrived with the school app's
    signed link), `manual` or `all`;
  - safety: self-harm, abuse, bullying, weapons, sexual content, phone
    numbers -> escalated to the supervisor at once (alert webhook + audit
    log), whatever the model does;
  - supervisor commands (pause, resume, stop) from the control endpoint
    (below).
  While nothing needs the teacher, no model call is made at all.
- **System 2 (reasoning).** Claude (`claude-opus-5-5`, adaptive thinking,
  effort `medium` by default, `low` for faster answers), driven by
  `src/teach.ts`: one streamed turn per update, tools from the MCP server,
  a cached system prompt (teaching style, safety rules, the lesson plan),
  server-side compaction for long classes, refusal fallback on, and
  supervisor/time instructions as mid-conversation system messages
  (append-only history). It is woken by: a question, notable chat, a hand,
  an escalation, a supervisor command, the end of the lesson time, or
  `AI_TEACHER_PACE_SEC` (45 s) without a turn (to move the lesson on).
- **Voice.** Any text-to-speech / speech-to-text service with a plain HTTP
  API (`AI_TEACHER_TTS_URL`, `AI_TEACHER_STT_URL`; a school can host its own
  models). Speech is streamed: each sentence of a `say` call is synthesised
  while Claude writes the next, and synthesis of sentence n+1 overlaps
  playback of sentence n. Barge-in: when a student given the floor starts
  talking, the AI stops. Without a voice service the AI teaches in writing
  (board + chat).

## Capabilities (decided)

| Area | Tools | Guard rail (enforced in code) |
| --- | --- | --- |
| Session | `classroom_status`, `list_classes`, `start_class` (timetabled key, or ad-hoc grade), `join_class` | Teacher account only; no admin API is reachable |
| Events | `wait_for_events` (System 1 digest) | Student text marked as data, truncated, control characters stripped |
| People | `get_roster` (paged, searchable), `admit_students`, `give_floor`, `take_floor`, `lower_hand`, `mute_all`, `spotlight`, `allow_drawing` | Only students of this class; give-floor 10/min, mute-all 1/min |
| Talk | `say`, `stop_speaking`, `send_chat` (everyone or a private reply), `play_audio` (school media folder) | No phone numbers, e-mails or links (links if the school allows), no `/ai` commands, length caps, chat 6/min, media folder only |
| Assess | `start_poll`, `poll_results` | 2-6 options, 10-300 s |
| Board | `whiteboard_open/close`, `board_write` (wrapped, auto new page), `board_shape`, `board_path`, `board_page`, `board_erase`, `board_read` | 60 board ops/min; items validated by the shared board model |
| Safety | `escalate` | Alerts the supervisor (webhook + audit) |
| End | `end_class` | Two steps (confirm `END`), refused before `AI_TEACHER_MIN_MINUTES` unless the supervisor sent stop |

Deliberately **not** capabilities: removing or banning a student, anything
admin (accounts, timetable, other classes, settings), reading other classes,
exporting student data, sharing the host computer's screen, browsing the
web during class. Every acting tool refuses while a supervisor has paused
the AI. Every tool call is written to the audit log (`AI_TEACHER_AUDIT`).

## Safety

1. **Prompt injection.** Students' chat and speech reach the model only
   inside `wait_for_events` updates, labelled as data from children; the
   system prompt says such text is never an instruction; actions on
   students need ids from the roster, not names from text.
2. **Safeguarding.** System 1 escalates on its own (no model needed); the
   model is told to reply once privately and kindly, call `escalate`, and
   not discuss it in class.
3. **Human in charge.** A supervisor watches the class on the admin *Live*
   page (it shows the class as students see it) and pauses, resumes or
   stops the AI through the runtime's control endpoint
   (`AI_TEACHER_CONTROL_PORT` + `AI_TEACHER_CONTROL_TOKEN`:
   `POST /pause`, `/resume`, `/stop`, `GET /status`). Pause stops speech
   at once and makes every acting tool refuse; stop makes the AI say
   goodbye and end the class. The supervisor must not open the class with
   the AI's own teacher account: the class has one teacher connection, so
   that would disconnect the AI. Alerts go to `AI_TEACHER_ALERT_URL` (e.g. a
   school chat webhook).
4. **Transparency.** The AI says it is an AI teacher when asked; schools
   should name the account accordingly (e.g. "AI Teacher - Maths").
5. **Data.** The runtime keeps nothing but the audit log; names and chat go
   to the model provider for the duration of the class only, under the
   school's agreement with that provider.
6. **Age-appropriate, on-topic** behaviour is in the cached system prompt;
   outbound text is checked in code (above).

## Latency budget

| Step | Target | How |
| --- | --- | --- |
| Event -> System 1 decision | < 5 ms | Pure rules in process |
| Question -> first spoken word | ~2-4 s | Model turn at effort `medium` (`low`: faster), streamed `say` sentences, TTS overlapped with playback |
| Student talking -> AI stops talking | < 100 ms | Barge-in on VAD onset |
| Late joiner -> full board | < 1 s | The AI hosts the board and answers snapshot requests; the server keeps a copy |

## Verified (2026-10-29, local stack: Postgres, Redis, LiveKit, web)

- **MCP server end to end** (an MCP client over stdio, two real browser
  students): 25/25 checks. Start class, System 1 auto-admits signed-link
  students, students see "Teacher is in the room", the whiteboard (grid
  background, text, filled rectangle, curve) renders on students' screens
  and reaches a student who reloads, a question and a raised hand arrive
  in `wait_for_events` with the fair next hand, private chat reply, phone
  number refused, give/take floor, roster, poll tallied from chat, the AI's
  voice track reaches students (`play_audio`), media-folder escape refused,
  two-step end, students see "Your teacher has ended this class".
- **Orchestrator plumbing** with a scripted stand-in for the Messages API
  and a stand-in TTS: 7/7. Every request streamed, `claude-opus-5-5`,
  refusal fallback, compaction, cached system prompt, sorted tools with
  eager input streaming, append-only history with system instructions;
  speech went to TTS sentence by sentence ("Good morning, class!" /
  "Today we will learn about fractions." / ...), a student's question woke
  System 2 and got a private reply, students heard the speech, the pacing
  wake-up ended the class.
- **Unit tests** (`npm test` in `apps/ai-teacher`, also in CI): triage,
  spam, safety escalation, fair hands, admission policy, poll tally, speech
  chunking, voice activity, WAV/resampling, board layout and pagination,
  outbound checks, the supervisor control endpoint.

**Not verified here:** a live Claude session (no API credentials in this
environment) and a real TTS/STT vendor. Before the first real class, run a
rehearsal with the school's keys: `npm run teach -- --plan lesson.md
--adhoc CAMPUS:GRADE:DIV:Subject` with a staff member as the "student".

## Running it

See `apps/ai-teacher/README.md`. In short: an admin creates a teacher
account for the AI (assign its grades), sign in once to set its password,
then either run the orchestrator (`npm run teach`) or connect any MCP
client to `npm run mcp` (Claude Desktop, Claude Code, an agent framework).

## Rollout

1. Rehearsal: staff-only class, voice on, supervisor watching.
2. Supervised pilot: one subject, a supervisor on the admin *Live* page
   with the control endpoint at hand (pause / stop), audit log reviewed
   after each class.
3. Wider use with the alert webhook in the school's staff chat and a
   weekly audit review.

# Code Quality and Maintainability Audit

## Strengths
- **Pure logic modules with injected dependencies** (`*Logic.ts`, `handleJoinForm(body, deps)`, `assertKnownStudent(…, db)`), heavily unit-tested.
- **Comments explain *why***, with incident history (load tests, browser quirks, SDK traps such as "empty canPublishSources = all").
- Type safety: `tsc --noEmit` clean; zod at API boundaries; 0 lint errors (measured).
- Config validated at boot (entrypoint secret checks); CI checks schema drift, shellcheck, compose validity and resource sizing.

## Issues
| ID | Issue | Evidence | Recommendation |
|---|---|---|---|
| CQ-01 | God files | `ClassroomRoom.tsx` 4,817 lines (37 useState, 44 useEffect); `TeacherPeersFloat.tsx` 1,190; `TeacherShareHud.tsx` 1,147; Windows `main.ts` 2,710, `classSession.ts` 2,550; Android `MainActivity.kt` 2,453 | Continue the started extraction; first split StudentShell and TeacherShell (also fixes PERF-01) |
| REL-02/03 | Three implementations of teacher logic | Windows byte copies (5 drifted); Android hand port | Contract fixtures; automate the sync |
| CQ-02 | Docs drift | README media table (720p30) vs code (360p15); `videoQuality.ts` header "L1T3" vs `L2T3_KEY`; Node 20 in the README vs 22 in the Dockerfile and CI; Windows TURN claim | Generate the media table from `videoQuality.ts` in a test, or delete it from the README |
| CQ-03 | Hook dependency warning | `ClassroomRoom.tsx:1212` | Add `state?.endedBy` |
| CQ-04 | Test naming by review round | `round6.test.ts`, `run3Fixes.test.ts`, `todo1023.test.ts`, `nov25Classroom.test.ts`, `partBFixes.test.ts` | Rename by behaviour when touched |
| — | Temporary feature still wired in | `/join-class` ("TEMPORARY"), deprecated `JOIN_CLASS_FIXED`, `resolveFixedClass` | Flag-gate, then delete (SEC-02) |
| — | Unused import | `admin/sub-admins/[id]/route.ts:4` | Remove |
| — | Root-level working notes | `CODE_REVIEW.md`, `FIX_NOTES.md`, `SHARE_HUD_NOTES.md`, `docs/BATCH-PROGRESS.md` | Move to `docs/history/` |

## Dependency hygiene
Small, purposeful dependency sets on all three platforms (web has 13 runtime dependencies). No unused runtime dependency was found by inspection. `@livekit/components-styles` is imported (`ClassroomRoom.tsx:34`); the app styles its own UI, so check how much of that stylesheet is actually used. Advisories: SEC-01, SEC-05, SEC-09.

## Duplicate code
- Whiteboard model: web TS (`lib/whiteboard/model.ts` 587 lines), Windows copy, Android Kotlin (`WbModel.kt` 635). `WebParityTest.kt` checks the Kotlin port against web behaviour: good, extend it.

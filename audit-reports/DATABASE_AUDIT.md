# Database Audit

PostgreSQL 16 through Prisma 5.22; 20 migrations (`apps/web/prisma/migrations`). CI checks that migrations apply to an empty database and that there is **no schema drift** (`ci.yml`): a good practice.

## Schema (models)
Admin, Teacher, TeacherAssignment, Room, Participant, Message, TimetableSlot, ScheduleOverride, ClassSession, Student, AttendanceRecord, Campus, Grade, Division, ClassFeedback, TeacherRankSnapshot, AcademicYear, SchoolSetting.

## Index review (from `schema.prisma`)
| Query path | Index | OK? |
|---|---|---|
| Student session lookup by cookie | `Participant.sessionToken @unique` | ✓ |
| Roster per room | `Participant @@index([roomId, status])` | ✓ |
| Teacher participant (`token/route.ts:31`: roomId + role) | covered by `(roomId, status)` prefix | ✓ (fine at class size) |
| Chat history | `Message @@index([roomId, createdAt])` | ✓ |
| Attendance upsert | `@@unique([classSessionId, studentId])` | ✓ |
| Timetable by teacher/day, by class/day | `(teacherId, weekday)`, `(campus, grade, weekday)`, GIN `campuses` | ✓ |
| Sessions by date / teacher | `(teacherId, sessionDate)`, `(sessionDate)` | ✓ |
| Retention sweep (`role, status, leftAt < cutoff`) | **none on leftAt** | PERF-08: add `CREATE INDEX … ON "Participant"("leftAt") WHERE status='LEFT'` |
| Student roster import / search | `Student(campus, grade, division)`, `externalId @unique` | ✓ |

## Growth
| Table | Growth driver | Control |
|---|---|---|
| Participant | 1 row per student per class | Pruned after 30 days (`retention.ts`) |
| Message | Chat | Deleted when the teacher's room reopens (SEC-07: add a time-based purge) |
| AttendanceRecord | 1 per student per class | Kept (school record); roughly 2,500 × 6 classes × 200 days ≈ 3 M rows/year: fine |
| Student | Imports + `WEB-` name joins | SEC-03 |
| TeacherRankSnapshot | Weekly | Small |

## Transactions and locking
- Attendance flush uses `$queryRaw` inside a transaction (`attendanceService.ts:95`); the batches come from the Redis queue, so the DB sees few large writes rather than many small ones.
- Single active session updates are single-row.

## Operations gaps
- **No backup/restore** (INF-01).
- No `pg_stat_statements`, no slow-query log → no execution plans were captured (**not measured**).
- `max_parallel_workers_per_gather=0` (deliberate on few cores): fine.

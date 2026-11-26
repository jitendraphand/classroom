# Administrator Experience Audit

Roles found: **System admin** (one, bootstrapped), **Sub-admin** (privilege set; optionally linked to a teacher, who switches views), **hidden observer** (admin in a live class). No parent, moderator or support roles exist.

## Pages (verified routes)
`/admin` (home: today, late classes, live banner) · `/admin/teachers` · `/admin/timetable` · `/admin/grades` · `/admin/students` (CSV import) · `/admin/reports` (attendance per class/student, CSV) · `/admin/performance` (teacher ranking, feedback) · `/admin/live` and `/admin/live/[code]` (zero-stream overview, gated observer, end class) · `/admin/system/{admins,settings,years}`.

## Strengths
- Every admin API calls `requireAdminApi(privilege)`; SYSTEM-only actions are distinguished (`lib/adminGuard.ts`).
- Timetable clash detection (teacher overlap is blocked; grade overlap needs confirmation).
- The live overview is "zero-stream" until the admin opts in to observe (commit `d501e7a`): cheap on bandwidth.
- CSV exports for attendance.

## Problems
| Problem | Severity | Fix |
|---|---|---|
| No backups / restore UI or docs | MEDIUM (INF-01) | Nightly dump + documented restore |
| No system monitoring page (egress, LiveKit health, errors) | MEDIUM (INF-02) | Metrics + a small status panel |
| Admin cannot see *why* a student failed to connect | MEDIUM | Surface webhook `participant_connection_aborted` counts per class |
| Name-form joins can pollute the student list | MEDIUM (SEC-03) | Strict roster; a bulk "merge duplicates" tool |
| Observers are invisible to the class | Policy | State it in the school privacy notice |
| `/admin/live/[code]` ships 383 KiB gzip JS | LOW | Acceptable for staff; can share the PERF-01 split |
| Audit log | Partial (`lib/auditLog.ts`: class-ended-by) | Extend to admin mutations (teacher create/disable, password reset, settings) |

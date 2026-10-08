# Grades & divisions (admin master list)

Admin → **Grades & divisions** (`/admin/grades`) holds the list of grades and
their divisions. It fills every grade/division dropdown in the app:

| Where | Control |
|---|---|
| Timetable: weekly slot form, one-off "Extra class" form | Grade select → division multi-select with **All divisions** |
| Timetable: "By grade-division" view | Grade select → division select (optional) |
| Teachers: create / edit assignments | Chips + grade select → division select (or **All divisions**) |
| Attendance reports (admin and teacher) and Students filters | Grade select → division select ("Any") |
| Teacher dashboard: ad-hoc class | Only the teacher's assigned grades; divisions = explicitly assigned ones, plus every active division of a whole-grade (ALL) assignment |
| Students → Import roster | Rows must use an active grade + division of the list; others are reported and skipped |

## Campuses

The same page (`/admin/grades`, menu **Campuses & grades**) also holds the
**campuses** (`Campus`: canonical `name` via `normalizeCampus` — upper-case,
spaces removed, e.g. "CC", "NORTH" — plus `label`, `sortOrder`, `active`).
Campus is the third routing criterion: timetable slots, extra classes, ad-hoc
classes, teacher assignments and students all carry a campus, and a student is
routed only to classes of their own campus + grade + division. Grades and
divisions are shared by all campuses.

- Add / rename the label any time; change the code or delete only while unused;
  deactivate to hide it from new selections (existing rows keep it).
- **Sync from existing data** also adds campuses already used.
- Every grade/division dropdown above has a campus dropdown next to it
  (timetable slot/extra forms and "By grade-division" view, teacher
  assignments `CC · 7-A`, students filter + roster import, reports filters,
  teacher ad-hoc class, Live now filter).
- Join links: `&Campus=` (case/space-insensitive). Without it the only active
  campus is used; with several campuses the join is refused with
  `campus_required` (see SCHOOL_APP_INTEGRATION.md).
- Roster CSV: optional `campus` column; rows without one use the campus picked
  on the import form (or the only campus).
- The schema has no back-compat default: the production database was wiped
  for this change on 2026-10-08 (backup kept on the server).

Only **active** entries appear in dropdowns. A value already saved on a row that
is not (or no longer) in the list stays visible and selected, marked
"not in list" / ⚠, so editing an old row never silently drops it.

## Data model

- `Grade`: `name` (canonical, `normalizeGrade`: "7", "KG", "XII"), `label`
  (display), `sortOrder`, `active`.
- `Division`: belongs to a grade; `name` canonical like everywhere else
  (`normalizeDivision`: upper-case, no spaces, e.g. "MAHAVEER", "RANILAXMI"),
  `label` display form ("Mahaveer", "Rani Laxmi"), `active`. Unique per grade.
  Division names are letters/digits only; "ALL" / "*" is reserved for
  "all divisions".
- Timetable slots, overrides, class sessions, teacher assignments and students
  keep their plain canonical strings — **no foreign keys**. Editing the list
  never rewrites timetable, attendance or student history.

## Rules

- **Rename**: the display label can always change. The canonical name
  (e.g. "A" → "D") can change only while nothing uses the entry, because
  students arrive from the school app with fixed values and history keeps the
  string. Otherwise add a new entry and deactivate the old one.
- **Deactivate**: always allowed. Hidden from dropdowns; existing slots,
  assignments, students and reports keep working (validation still accepts
  inactive entries on existing rows; roster import requires active ones).
- **Delete**: blocked (HTTP 409) while anything uses it — teacher
  assignments, timetable slots, one-off changes, students, or class sessions in
  history — and the message lists what uses it and offers to deactivate
  instead. Deleting an unused grade deletes its (unused) divisions.
- **Reorder**: ▲/▼ on grades; dropdowns follow this order.
- **Validation of new entries**: new timetable slots/overrides, teacher
  assignments and ad-hoc classes must use grades/divisions in the list (an
  unchanged audience on an edited slot, or an assignment the teacher already
  holds, is not re-checked). **If the list is empty** (fresh install, nothing
  set up yet) validation is skipped and the pickers fall back to free text.

## Students with an unknown grade/division (school app links)

Choice: **accept, save, and flag for the admin.** A student whose
`Grade`/`Division` is not in the list still joins and is saved (attendance
identity is never lost); since nothing can be scheduled for it they see
"No class right now". The admin page shows
**"Unrecognised grade/divisions seen from the school app"** (computed from the
Students table, with student counts) with a one-click **Add** that creates the
grade and/or division (or re-activates an inactive one). Entries that exist but
are inactive are not flagged (the admin deactivated them on purpose). Nothing
extra is written at join time.

## Migration / backfill

`prisma/migrations/20261002200000_grade_division_master` creates the two tables
and backfills them from every grade/division already in use: teacher
assignments, timetable slots, one-off changes (with a grade), students and class
sessions. Grades get `sortOrder` 10, 20, … (numeric grades first, in numeric
order, then others alphabetically) and `label = name`; divisions get the
friendly label ("MAHAVEER" → "Mahaveer"). Whole-grade assignments ("*") and
all-division slots add the grade only. So every existing row stays valid and
every current value appears in the dropdowns right after `prisma migrate deploy`.

**Sync from existing data** on the admin page runs the same backfill again
(idempotent: only adds what is missing), e.g. after importing old data.

## API (admin session + the usual Origin/CSRF checks on writes)

| Method | Path | Body |
|---|---|---|
| GET | `/api/admin/grades` | — (all entries incl. inactive, usage counts, unrecognised list) |
| POST | `/api/admin/grades` | `{ label, divisions? }` |
| PATCH / DELETE | `/api/admin/grades/:id` | `{ label?, active?, sortOrder? }` |
| POST | `/api/admin/grades/:id/divisions` | `{ name }` ("A" or "A, B") |
| PATCH / DELETE | `/api/admin/divisions/:id` | `{ label?, active? }` |
| POST | `/api/admin/grades/reorder` | `{ ids }` |
| POST | `/api/admin/grades/sync` | — |
| POST | `/api/admin/grades/recognise` | `{ grade, division }` |
| GET | `/api/grades/options` | — (admin **or teacher** session; active entries only) |

Code: `lib/gradeMasterLogic.ts` (pure rules), `lib/gradeMasterApi.ts` (handlers,
injected deps), `lib/gradeMaster.ts` (Prisma), `components/admin/GradePickers.tsx`,
`app/admin/grades/page.tsx`. Tests: `tests/gradeMaster.test.ts`.

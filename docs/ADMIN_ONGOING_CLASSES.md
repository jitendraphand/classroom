# Admin → Ongoing classes

`/admin/live` (nav tab **Ongoing classes**; `/admin` shows a "N classes live
now" banner while any class runs) is a responsive grid with one tile per class
that is running right now.

## Tile

- **Live, muted preview of what students see**: teacher screen share if one is
  published, otherwise the teacher camera, otherwise the student placeholder
  ("Teacher camera off" when the teacher is connected, "Waiting for teacher…"
  when not). Rendered by `components/classroom/StudentViewStage.tsx`, which
  reuses the student stage's `TeacherScreenStage` / `isTeacherParticipant`.
- Bandwidth: the preview connects with `autoSubscribe: false`, subscribes to
  the teacher's camera / screen tracks only, requests `VideoQuality.LOW` with
  `adaptiveStream` (sized to the tile), never subscribes to audio, and only
  connects while the tile is on screen (IntersectionObserver).
- Overlay: live elapsed time since `ClassSession.startedAt` (the actual start,
  not the slot start; `mm:ss`, then `h:mm:ss`) and students connected now.
  Title: room name (subject · grade-division), grade-division, teacher.
- The list refreshes every 5 s (only while the page is visible).
- Click → `/admin/live/<CODE>`: the admin sits in the class as an observer.

## Observer (admin sitting in a class)

- **Hidden** LiveKit participant (`hidden: true`): not in the teacher's
  mosaic, roster or anyone's participant list; no Participant row and no
  waiting room; never counted in attendance (attendance only records
  `student_…` identities; observer identities are `adminobserver_…` /
  `adminpreview_…`, and the presence webhook ignores them).
- **Listen-only**: `canPublish: false`, `canPublishData: false`, no publish
  sources. Camera and mic are off and cannot be turned on — a supervisor who
  could speak while invisible would be confusing for the class. If an admin
  needs to address the class, they should join visibly through the teacher.
- **Student-level visibility + roster**: the admin sees exactly the student
  stage (teacher share / camera, read-only annotations) and hears the teacher,
  plus a list of the connected students' names. Student video and audio are
  never available: students restrict their tracks to the participants they
  can see (teachers: everything; classmates: mic only), and a hidden observer
  is not one of them — so this is enforced by the SFU, not just the UI.

## API (admin session required; `requireAdminApi`)

| Method | Path | Returns |
|---|---|---|
| GET | `/api/admin/live` | `{ classes: [{ code, sessionId, classSessionId, title, subject, gradeDivision, teacherName, startedAt, studentCount, teacherConnected, countSource }] }` (empty list when none) |
| GET | `/api/admin/live/<CODE>` | `{ class, students: [{ id, name, gradeDivision, rollNumber }] }`, 404 if not live |
| POST | `/api/admin/live/<CODE>/token` `{ mode: "preview" \| "observe" }` | `{ token, identity, serverUrl, mode, class }` |

Teacher / student / anonymous callers get 401 before anything is read or a
token minted. POST goes through the Origin / content-type CSRF guard.

Tokens: `preview` TTL 2 min, `observe` 10 min (LiveKit refreshes a connected
participant's token itself); both `hidden`, `canSubscribe` only. LiveKit
grants cannot limit a subscriber to specific tracks, so "teacher tracks only"
is the client's subscription policy, backed by the students' SFU-side
subscription permissions for everything students publish.

**Ongoing** = room not ENDED, pointing at this ClassSession, started and not
ended (same rule students use). **Student count** = distinct `student_…`
identities in the LiveKit room (`listParticipants`, the same source the
attendance webhook records); if LiveKit is unreachable, open attendance
intervals (`AttendanceRecord.connectedSince`) are used and `countSource` is
`attendance`.

## Limitations

- The teacher camera is simulcast (180p / 360p / 720p, see
  `lib/videoQuality.ts`), so a tile receives the ~140 kbps 180p layer. The
  screen share is single-layer (≤1080p, ≤1.5 Mbps), so a tile showing a share
  receives the full share stream.
- One WebRTC connection per visible tile; with many simultaneous classes, scroll
  (off-screen tiles disconnect).
- Annotation strokes drawn before the observer joined are not shown (the
  snapshot endpoint is participant-only); new strokes appear live. Tiles show
  no annotations.
- The observer does not hear students (they only allow participants they can
  see), which is stricter than what a student hears.

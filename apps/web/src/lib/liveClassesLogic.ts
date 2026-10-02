/**
 * Pure helpers for the admin "Ongoing classes" view (no Prisma / Next / LiveKit
 * imports), shared by the server, the admin UI and the unit tests.
 */

export type LiveClass = {
  /** Teacher's permanent room code (what the admin joins). */
  code: string;
  /** Current room session id (part of the LiveKit room name). */
  sessionId: string;
  classSessionId: string;
  title: string;
  subject: string;
  /** e.g. "7-A, B" or "8 (all divisions)". */
  gradeDivision: string;
  teacherName: string;
  /** ISO time the teacher actually started the class (not the slot start). */
  startedAt: string;
  /** Students currently connected to the class media room. */
  studentCount: number;
  /** Whether the teacher is connected to the media room right now (null = unknown). */
  teacherConnected: boolean | null;
  /** Where the counts came from: the SFU (live) or attendance records (fallback). */
  countSource: 'livekit' | 'attendance';
};

export type LiveRoomParticipant = { identity: string; metadata?: string | null };

/** Teacher identities are `teacher_…`; metadata role TEACHER is the fallback. */
function isTeacher(p: LiveRoomParticipant) {
  if (p.identity.startsWith('teacher_')) return true;
  if (p.identity.startsWith('student_')) return false;
  try {
    return (p.metadata ? JSON.parse(p.metadata) : {})?.role === 'TEACHER';
  } catch {
    return false;
  }
}

/**
 * Who is in the SFU room, by the same rule attendance uses (the webhook only
 * records `student_…` identities). A student with two tabs is one student.
 * Hidden admin observers/previews are neither.
 */
export function summarizeRoomParticipants(list: LiveRoomParticipant[]) {
  const students = new Set<string>();
  let teacherConnected = false;
  for (const p of list) {
    if (p.identity.startsWith('student_')) students.add(p.identity);
    else if (isTeacher(p)) teacherConnected = true;
  }
  return { studentIdentities: [...students], studentCount: students.size, teacherConnected };
}

/**
 * A class is ongoing when its room is open for exactly this class session and
 * the teacher has started it and not ended it (same rule students use to see a
 * class as live).
 */
export function isOngoingClass(
  room: { status: string; classSessionId: string | null },
  cs: { id: string; startedAt: Date | null; endedAt: Date | null }
) {
  return room.status !== 'ENDED' && room.classSessionId === cs.id && !!cs.startedAt && !cs.endedAt;
}

/** Elapsed time as m:ss under an hour (zero-padded mm:ss) and h:mm:ss after. */
export function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function parseObserverMode(raw: unknown): 'preview' | 'observe' | null {
  return raw === 'preview' || raw === 'observe' ? raw : null;
}

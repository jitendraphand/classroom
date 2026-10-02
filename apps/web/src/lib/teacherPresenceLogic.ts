/**
 * Pure rules for "students are force-muted while the teacher is not connected
 * to the LiveKit room". No Prisma / Redis / network imports so the rules can be
 * unit-tested and shared by the token route, the webhook and permission sync.
 */

/** Minimal shape of a LiveKit ParticipantInfo (server SDK) we care about. */
export type PresenceParticipant = {
  identity: string;
  sid?: string;
  metadata?: string;
  /** ParticipantInfo.State: 0 JOINING, 1 JOINED, 2 ACTIVE, 3 DISCONNECTED */
  state?: number;
};

const DISCONNECTED = 3;

/** Teacher identities are `teacher_…` (codes.generateIdentity); metadata is a fallback. */
export function isTeacherIdentity(identity: string, metadata?: string | null): boolean {
  if (identity.startsWith('teacher_')) return true;
  if (identity.startsWith('student_')) return false;
  if (!metadata) return false;
  try {
    const meta = JSON.parse(metadata) as { role?: unknown };
    return meta?.role === 'TEACHER';
  } catch {
    return false;
  }
}

/**
 * Is a teacher connected, given the room's participant list?
 * `leftSid` removes a participant the caller knows just left (LiveKit may still
 * list it for a moment); `joined` adds one the caller knows just joined. Using
 * the SID (not identity) keeps a duplicate-identity reconnect correct: the old
 * session leaving must not hide the new one.
 */
export function teacherPresentAmong(
  participants: PresenceParticipant[],
  opts: { leftSid?: string | null; joined?: PresenceParticipant | null } = {}
): boolean {
  const list = participants.filter(
    (p) => p.state !== DISCONNECTED && !(opts.leftSid && p.sid && p.sid === opts.leftSid)
  );
  if (opts.joined && opts.joined.state !== DISCONNECTED) list.push(opts.joined);
  return list.some((p) => isTeacherIdentity(p.identity, p.metadata));
}

/**
 * A student may publish their microphone only when the teacher has not muted
 * them AND the teacher is connected. The teacher mute always wins; presence
 * never un-mutes a teacher-muted student.
 */
export function studentMicAllowed(input: { mutedByTeacher: boolean; teacherPresent: boolean }): boolean {
  return !input.mutedByTeacher && input.teacherPresent;
}

/** `classroom_<CODE>_<sessionId>` → parts (see livekit.livekitRoomName). */
export function parseLivekitRoomName(name: string | undefined | null): { code: string; sessionId: string } | null {
  if (!name) return null;
  const m = /^classroom_([A-Z0-9]+)_([A-Za-z0-9]+)$/.exec(name);
  return m ? { code: m[1]!, sessionId: m[2]! } : null;
}

export type WebhookLike = {
  event?: string;
  room?: { name?: string } | null;
  participant?: PresenceParticipant | null;
};

export type PresenceAction =
  | { kind: 'ignore' }
  /** Room closed on the SFU: nobody (so no teacher) is connected. */
  | { kind: 'room-finished'; code: string; sessionId: string }
  /** A teacher joined or left: recompute presence and re-apply student mic permissions. */
  | {
      kind: 'teacher';
      code: string;
      sessionId: string;
      joined: PresenceParticipant | null;
      leftSid: string | null;
    }
  /** A student joined: make sure the lock applies to them if the teacher is absent. */
  | { kind: 'student-joined'; code: string; sessionId: string; identity: string };

const LEFT_EVENTS = new Set(['participant_left', 'participant_connection_aborted']);

/** Map a LiveKit webhook event to what the classroom must do about it. */
export function presenceActionFor(event: WebhookLike): PresenceAction {
  const room = parseLivekitRoomName(event.room?.name);
  if (!room || !event.event) return { kind: 'ignore' };
  if (event.event === 'room_finished') return { kind: 'room-finished', ...room };

  const p = event.participant;
  if (!p?.identity) return { kind: 'ignore' };
  const teacher = isTeacherIdentity(p.identity, p.metadata);

  if (event.event === 'participant_joined') {
    if (teacher) return { kind: 'teacher', ...room, joined: p, leftSid: null };
    // Hidden admin observers/previews (`admin…_`) are neither role: nothing to do.
    return p.identity.startsWith('student_')
      ? { kind: 'student-joined', ...room, identity: p.identity }
      : { kind: 'ignore' };
  }
  if (LEFT_EVENTS.has(event.event) && teacher) {
    return { kind: 'teacher', ...room, joined: null, leftSid: p.sid ?? null };
  }
  return { kind: 'ignore' };
}

/** Short reason shown on the student's locked mic button. */
export const MIC_LOCKED_NO_TEACHER = 'Mic locked — teacher not in class';

export type RoomRef = { code: string; sessionId: string };

/** Side effects the webhook handler needs; injected so the flow is unit-testable. */
export type PresenceDeps = {
  findRoom: (code: string) => Promise<(RoomRef & { status: string }) | null>;
  listParticipants: (room: RoomRef) => Promise<PresenceParticipant[]>;
  isTeacherPresent: (room: RoomRef) => Promise<boolean>;
  recordPresence: (room: RoomRef, present: boolean) => Promise<void>;
  applyStudentMicLock: (room: RoomRef, present: boolean, onlyIdentities?: string[]) => Promise<void>;
};

export type PresenceOutcome =
  | { handled: false; reason: string }
  | { handled: true; code: string; teacherPresent: boolean; applied: 'all' | 'one' | 'none' };

/**
 * React to one verified LiveKit webhook event.
 * - teacher joined/left → recompute presence from the SFU (falling back to the
 *   event itself if LiveKit cannot be listed), record it, re-apply every
 *   connected student's mic permission.
 * - student joined while the teacher is away → lock that student (covers a
 *   token minted from a stale presence cache).
 * - room finished → record "absent" (nothing to push: nobody is connected).
 * Events for another session of the same permanent code, or an ended class,
 * are ignored.
 */
export async function handlePresenceEvent(event: WebhookLike, deps: PresenceDeps): Promise<PresenceOutcome> {
  const action = presenceActionFor(event);
  if (action.kind === 'ignore') return { handled: false, reason: 'not a classroom presence event' };

  const room = await deps.findRoom(action.code);
  if (!room || room.sessionId !== action.sessionId) {
    return { handled: false, reason: 'stale or unknown session' };
  }
  if (room.status === 'ENDED') return { handled: false, reason: 'class ended' };
  const ref: RoomRef = { code: room.code, sessionId: room.sessionId };

  if (action.kind === 'room-finished') {
    await deps.recordPresence(ref, false);
    return { handled: true, code: ref.code, teacherPresent: false, applied: 'none' };
  }

  if (action.kind === 'student-joined') {
    const present = await deps.isTeacherPresent(ref);
    if (present) return { handled: true, code: ref.code, teacherPresent: true, applied: 'none' };
    await deps.applyStudentMicLock(ref, false, [action.identity]);
    return { handled: true, code: ref.code, teacherPresent: false, applied: 'one' };
  }

  let present: boolean;
  try {
    present = teacherPresentAmong(await deps.listParticipants(ref), {
      joined: action.joined,
      leftSid: action.leftSid,
    });
  } catch {
    present = !!action.joined;
  }
  await deps.recordPresence(ref, present);
  await deps.applyStudentMicLock(ref, present);
  return { handled: true, code: ref.code, teacherPresent: present, applied: 'all' };
}

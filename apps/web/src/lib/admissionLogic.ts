/**
 * Waiting-room rules (pure, unit-tested). The teacher may switch the waiting
 * room off for the running class session; students are then admitted on
 * arrival. Admission never changes what an admitted student may do: they stay
 * muted by the teacher, are routed only to their own class, and never receive
 * other students' video.
 */
export type AdmissionRoom = { status: string; waitingRoomOn: boolean };
export type AdmissionParticipant = { role: string; status: string };

/**
 * May this student use direct entry, given their earlier seats in the same
 * class session? Yes unless the teacher denied or removed one of them (and
 * has not admitted the student since: admitWaiting clears the flag). A
 * student who pressed Leave themselves, dropped, or switched device comes
 * straight back in.
 */
export function directEntryAllowed(previousSeats: { removedByTeacher: boolean }[]): boolean {
  return !previousSeats.some((s) => s.removedByTeacher);
}

/** Should this participant be admitted straight away (no waiting room)? */
export function shouldAutoAdmit(room: AdmissionRoom, p: AdmissionParticipant): boolean {
  return room.status !== 'ENDED' && !room.waitingRoomOn && p.role === 'STUDENT' && p.status === 'WAITING';
}

/** Who an earlier seat belongs to: the school student in a session, or (manual joins) a name. */
export type SeatOwner = { studentId: string | null; classSessionId?: string | null; displayName: string };

export function seatOwnerKey(p: SeatOwner): string {
  return p.studentId ? `s:${p.studentId}:${p.classSessionId ?? ''}` : `n:${p.displayName}`;
}

/**
 * Turning the waiting room off admits everyone currently waiting, except
 * students the teacher denied or removed in this session (`removed`: their
 * earlier seats); those still wait for an explicit Admit. Turning it on
 * admits nobody.
 */
export function idsToAdmitOnToggle(
  waitingRoomOn: boolean,
  waiting: ({ id: string; role: string; status: string } & Partial<SeatOwner>)[],
  removed: SeatOwner[] = [],
): string[] {
  if (waitingRoomOn) return [];
  const blocked = new Set(removed.map(seatOwnerKey));
  return waiting
    .filter((p) => p.role === 'STUDENT' && p.status === 'WAITING')
    .filter((p) => p.displayName === undefined || !blocked.has(seatOwnerKey({ studentId: p.studentId ?? null, classSessionId: p.classSessionId, displayName: p.displayName })))
    .map((p) => p.id);
}

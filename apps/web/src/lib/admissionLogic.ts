/**
 * Waiting-room rules (pure, unit-tested). The teacher may switch the waiting
 * room off for the running class session; students are then admitted on
 * arrival. Admission never changes what an admitted student may do: they stay
 * muted by the teacher, are routed only to their own class, and never receive
 * other students' video.
 */
export type AdmissionRoom = { status: string; waitingRoomOn: boolean };
export type AdmissionParticipant = { role: string; status: string };

/** Should this participant be admitted straight away (no waiting room)? */
export function shouldAutoAdmit(room: AdmissionRoom, p: AdmissionParticipant): boolean {
  return room.status !== 'ENDED' && !room.waitingRoomOn && p.role === 'STUDENT' && p.status === 'WAITING';
}

/** Turning the waiting room off admits everyone currently waiting; turning it on admits nobody. */
export function idsToAdmitOnToggle(waitingRoomOn: boolean, waiting: { id: string; role: string; status: string }[]): string[] {
  if (waitingRoomOn) return [];
  return waiting.filter((p) => p.role === 'STUDENT' && p.status === 'WAITING').map((p) => p.id);
}

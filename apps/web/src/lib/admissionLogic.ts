/**
 * Admission rules (pure, unit-tested). There is no waiting room (removed
 * Nov 26): every student who may enter the class (school students: only their
 * own grade/division's class) is admitted on arrival. Admission never changes
 * what a student may do: they join muted, are routed only to their own class,
 * and never receive other students' video.
 *
 * Remove is a "kick": the student leaves the class now and may come back in
 * (there is no one to admit them any more).
 */
export type AdmissionRoom = { status: string };
export type AdmissionParticipant = { role: string; status: string };

/** Should this seat be admitted now? Any student seat not yet in, while the class runs. */
export function shouldAutoAdmit(room: AdmissionRoom, p: AdmissionParticipant): boolean {
  return room.status !== 'ENDED' && p.role === 'STUDENT' && p.status === 'WAITING';
}

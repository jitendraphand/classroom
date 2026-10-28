/**
 * Why a student's class view stopped for good (pure, shared). After any of
 * these the client disconnects LiveKit, stops every poll/timer/listener/track,
 * tries window.close(), and otherwise shows a static screen that makes no
 * network requests.
 */
export type FinishReason = 'left' | 'ended' | 'removed' | 'replaced';

export function finishFromState(
  s: { status?: string; ended?: boolean; public?: boolean; replaced?: boolean; meLeft?: boolean } | null | undefined
): FinishReason | null {
  if (!s) return null;
  if (s.replaced) return 'replaced';
  if (s.status === 'ENDED' || s.ended) return 'ended';
  if (s.public && s.meLeft) return 'removed';
  return null;
}

export function finishCopy(r: FinishReason): { title: string; body: string } {
  switch (r) {
    case 'replaced':
      return { title: 'You joined from another device', body: 'This class is open on your other device, so this one was disconnected. You can close this tab.' };
    case 'removed':
      return { title: 'You were removed from the class', body: 'Your teacher removed you from this class. You can close this tab.' };
    case 'left':
      return { title: 'You left the class', body: 'You can rejoin while the class is still on, or close this tab.' };
    default:
      return { title: 'Class ended', body: 'Your teacher has ended this class. You can close this tab.' };
  }
}

/** The "class ended" screen (teacher: finished screen after End class, instead of jumping to the dashboard). */
export function classEndedCopy(isTeacher: boolean): { title: string; body: string } {
  return isTeacher
    ? { title: 'Class finished', body: 'The class has ended for everyone and attendance is saved. You can go back to your dashboard.' }
    : { title: 'Class ended', body: 'Your teacher has ended this class. You can leave this page.' };
}

/** The teacher's after-class summary, from that session's attendance report row. */
export type ClassSummaryRow = {
  startedAt: string;
  endedAt: string;
  present: number;
  late: number;
  notAdmitted: number;
  absent: number;
  knownStudents: number;
};

export function classSummaryFacts(r: ClassSummaryRow): string[] {
  const facts: string[] = [];
  const mins = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  if (r.startedAt && r.endedAt) {
    // HH:MM in school time; a class past midnight wraps.
    const length = (mins(r.endedAt) - mins(r.startedAt) + 1440) % 1440;
    facts.push(`${r.startedAt}–${r.endedAt} (${length} min)`);
  }
  const attended = r.present + r.late;
  const counted = r.knownStudents > 0 ? `${attended} of ${r.knownStudents}` : `${attended}`;
  const noun = (r.knownStudents || attended) === 1 ? 'student' : 'students';
  facts.push(`${counted} ${noun} attended${r.late ? ` (${r.late} late)` : ''}`);
  if (r.absent) facts.push(`${r.absent} absent`);
  if (r.notAdmitted) facts.push(`${r.notAdmitted} waited but were not admitted`);
  return facts;
}

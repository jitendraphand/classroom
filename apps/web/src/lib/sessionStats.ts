import { audienceIncludes } from './grades';

type Person = {
  campus: string;
  grade: string;
  division: string;
  createdAt: Date;
  deletedAt: Date | null;
};

type SessionBits = {
  campus: string;
  grade: string;
  divisions: string[];
  allDivisions: boolean;
  endedAt: Date | null;
  scheduledEnd: Date | null;
};

/** Students known for this class's audience by the time it ended. Same rule as attendance reports. */
export function enrolledStudents<T extends Person>(cs: SessionBits, students: T[]): T[] {
  const cutoff = (cs.endedAt ?? cs.scheduledEnd ?? new Date()).getTime();
  return students.filter(
    (s) =>
      audienceIncludes(cs, s) &&
      s.createdAt.getTime() <= cutoff &&
      (!s.deletedAt || s.deletedAt.getTime() > cutoff)
  );
}

export function attendanceRatio(
  present: number,
  enrolled: number
): number | null {
  if (enrolled <= 0) return null;
  return present / enrolled;
}

/** Mean of present/enrolled over sessions that have a known audience. Null when none qualify. */
export function averageAttendance(ratios: Array<number | null>): number | null {
  const nums = ratios.filter((n): n is number => n != null && Number.isFinite(n));
  if (!nums.length) return null;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  return Math.round(mean * 1000) / 1000;
}

/**
 * Class timetable tones and today's board tags. (Classes have no size
 * limit: the optional "students per class" cap that used to live here was
 * removed; every student of the class can be admitted.)
 */

/**
 * Calendar / table tone for one class occurrence.
 * taken    — the class was held (started, and if it is over, it was completed)
 * today    — scheduled today and not yet completed or skipped
 * upcoming — a later date
 * skipped  — the date passed (or the start time today passed) and nobody started it
 */
export type ClassTone = 'taken' | 'today' | 'upcoming' | 'skipped';

export function classTone(input: {
  date: string;
  today: string;
  nowMinute: number;
  startMinute: number;
  endMinute: number;
  started: boolean;
  ended: boolean;
  cancelled?: boolean;
}): ClassTone {
  if (input.cancelled) return 'skipped';
  if (input.ended || (input.started && input.date < input.today)) return 'taken';
  if (input.date > input.today) return 'upcoming';
  if (input.date < input.today) return input.started ? 'taken' : 'skipped';
  if (input.ended) return 'taken';
  if (input.started) return 'today';
  if (input.nowMinute >= input.endMinute) return 'skipped';
  return 'today';
}

/** Today's admin board tag. "late" = inside the slot and nobody has started it yet. */
export type TodayTag = 'ongoing' | 'late' | 'not_taken' | 'starts' | 'completed';

export function todayTag(input: {
  nowMinute: number;
  startMinute: number;
  endMinute: number;
  started: boolean;
  ended: boolean;
  live: boolean;
  cancelled?: boolean;
}): TodayTag {
  if (input.ended) return 'completed';
  if (input.started && input.live) return 'ongoing';
  if (input.started && !input.ended) return 'ongoing';
  if (input.cancelled) return 'not_taken';
  if (input.nowMinute < input.startMinute) return 'starts';
  if (input.nowMinute < input.endMinute) return 'late';
  return 'not_taken';
}

export const TONE_LABEL: Record<ClassTone, string> = {
  taken: 'Taken / completed',
  today: "Today's scheduled",
  upcoming: 'Upcoming',
  skipped: 'Not taken / skipped',
};

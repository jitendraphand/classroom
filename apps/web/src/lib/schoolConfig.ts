/**
 * School scheduling / attendance settings from the environment. Read at call
 * time (not module load) so tests and runtime env changes apply.
 */
function intEnv(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function appTimeZone(): string {
  const tz = (process.env.APP_TIMEZONE || '').trim();
  return tz && validTimeZone(tz) ? tz : 'Asia/Kolkata';
}

/** Waiting room opens this many minutes before a scheduled start. */
export function earlyWindowMinutes(): number {
  return intEnv('WAITING_ROOM_EARLY_MINUTES', 10, 0, 120);
}

/** Joining later than start + this many minutes marks the student late. */
export function lateGraceMinutes(): number {
  return intEnv('LATE_GRACE_MINUTES', 5, 0, 120);
}

/** Manual code + name student join (dev/testing only). Default off. */
export function manualStudentJoinAllowed(): boolean {
  return (process.env.ALLOW_MANUAL_STUDENT_JOIN || '').trim().toLowerCase() === 'true';
}

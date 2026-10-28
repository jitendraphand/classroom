/**
 * Student video panel, cycled from the control bar (not from the panel itself):
 * both = teacher + self, teacher = teacher only, min = minimized.
 * The same three states apply in a normal class, a screen share and a whiteboard.
 */

export type StudentVideoMode = 'both' | 'teacher' | 'min';

export const STUDENT_VIDEO_MODES: StudentVideoMode[] = ['both', 'teacher', 'min'];

export function nextStudentVideoMode(mode: StudentVideoMode): StudentVideoMode {
  const i = STUDENT_VIDEO_MODES.indexOf(mode);
  return STUDENT_VIDEO_MODES[(i + 1) % STUDENT_VIDEO_MODES.length] ?? 'both';
}

export function studentVideoModeLabel(mode: StudentVideoMode): string {
  if (mode === 'both') return 'Videos: teacher and you. Click for teacher only.';
  if (mode === 'teacher') return 'Videos: teacher only. Click to minimize.';
  return 'Videos minimized. Click to show teacher and you.';
}

/** Short rail label. Full sentence stays in title / aria-description. */
export function studentVideoModeShortLabel(mode: StudentVideoMode): string {
  if (mode === 'both') return 'All';
  if (mode === 'teacher') return 'Teacher';
  return 'Hidden';
}

export function parseStudentVideoMode(v: unknown): StudentVideoMode {
  return v === 'teacher' || v === 'min' || v === 'both' ? v : 'both';
}

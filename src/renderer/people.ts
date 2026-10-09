/** Shared roster and chat labels for the main window and the floating panels. */

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0] ?? '';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? '';
  return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase() || '?';
}

export function avatarHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 33 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

export type Chip = { text: string; kind: string };

export function personChips(person: {
  handRaised: boolean;
  mutedByTeacher: boolean;
  pinned: boolean;
  late: boolean;
}): Chip[] {
  const chips: Chip[] = [];
  if (person.handRaised) chips.push({ text: 'Hand', kind: 'hand' });
  chips.push(person.mutedByTeacher ? { text: 'Muted', kind: 'muted' } : { text: 'May unmute', kind: 'ok' });
  if (person.pinned) chips.push({ text: 'Pinned', kind: 'pin' });
  if (person.late) chips.push({ text: 'Late', kind: 'late' });
  return chips;
}

/** Teacher chat badges: Everyone, DM, or To teacher. */
export function scopeBadge(scope: string): Chip {
  if (scope === 'DIRECT') return { text: 'DM', kind: 'dm' };
  if (scope === 'TEACHER') return { text: 'To teacher', kind: 'dm' };
  return { text: 'Everyone', kind: '' };
}

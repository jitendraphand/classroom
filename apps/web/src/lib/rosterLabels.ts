/**
 * Label of the teacher's own camera tile. The name falls back to "You"
 * before the room state names the teacher (e.g. right after a rejoin), which
 * used to read "You (you)".
 */
export function selfTileLabel(name: string | null | undefined): string {
  const n = (name ?? '').trim();
  if (!n || /^(you|me)$/i.test(n)) return 'You';
  return `${n} (you)`;
}

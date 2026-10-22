/**
 * Avatar letters. Strips a trailing "(you)" and any token that is not a word
 * so "LT Teacher (you)" is "LT", not "L(".
 */
export function nameInitials(name: string | null | undefined): string {
  const stripped = (name ?? '').replace(/\([^)]*\)/g, ' ');
  const parts = stripped
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => /[\p{L}]/u.test(w));
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

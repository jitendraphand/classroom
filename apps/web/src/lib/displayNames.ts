/**
 * Short but unambiguous label for a person: "Asha Kumar Patil" → "Asha P.".
 * Single-word names are returned unchanged; whitespace is collapsed.
 */
export function shortName(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  return `${parts[0]} ${last.charAt(0).toUpperCase()}.`;
}

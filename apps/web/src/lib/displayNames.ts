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

export type NamedPerson = { id: string; displayName: string; gradeDivision?: string | null; rollNumber?: string | null };

/** Expand a colliding short name rather than making two students look identical.
 * Use class/division (never a student ID) for equal full names. */
export function compactPersonLabel(person: NamedPerson, peers: readonly NamedPerson[]): string {
  const label = shortName(person.displayName);
  const collides = peers.some((p) => p.id !== person.id && shortName(p.displayName).toLowerCase() === label.toLowerCase());
  if (!collides) return person.gradeDivision ? `${label} · ${person.gradeDivision}` : label;
  const full = person.displayName.trim().replace(/\s+/g, ' ');
  return [full, person.gradeDivision, person.rollNumber ? `Roll ${person.rollNumber}` : null].filter(Boolean).join(' · ');
}

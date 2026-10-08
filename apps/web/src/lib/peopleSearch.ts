/**
 * Search used by the teacher's Roster and Class chat (in-page and the share
 * controls pop-ups). Pure; tested in tests/peopleSearch.test.ts.
 * Case-insensitive, extra spaces ignored; SID also matches with spaces removed.
 */

export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function matchesPerson(p: { displayName: string; sid?: string | null }, query: string): boolean {
  const q = normalizeQuery(query);
  if (!q) return true;
  if (p.displayName.toLowerCase().replace(/\s+/g, ' ').includes(q)) return true;
  const sid = (p.sid ?? '').toLowerCase();
  return !!sid && sid.includes(q.replace(/ /g, ''));
}

export function filterPeople<T extends { displayName: string; sid?: string | null }>(people: T[], query: string): T[] {
  if (!normalizeQuery(query)) return people;
  return people.filter((p) => matchesPerson(p, query));
}

/** Chat messages whose sender, recipient or text matches. */
export function filterMessages<
  M extends { senderName: string; recipientName?: string | null; body: string; senderParticipantId?: string; recipientParticipantId?: string | null },
>(messages: M[], query: string, sidById?: Map<string, string | null | undefined>): M[] {
  const q = normalizeQuery(query);
  if (!q) return messages;
  const qs = q.replace(/ /g, '');
  return messages.filter((m) => {
    if (m.senderName.toLowerCase().includes(q)) return true;
    if ((m.recipientName ?? '').toLowerCase().includes(q)) return true;
    if (m.body.toLowerCase().includes(q)) return true;
    if (sidById) {
      for (const id of [m.senderParticipantId, m.recipientParticipantId]) {
        const sid = id ? sidById.get(id) : null;
        if (sid && sid.toLowerCase().includes(qs)) return true;
      }
    }
    return false;
  });
}

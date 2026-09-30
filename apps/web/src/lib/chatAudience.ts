/**
 * Who may receive a chat message. Mirrors the GET /messages read filter:
 *
 * - BROADCAST: everyone admitted.
 * - TEACHER (student → teacher): the teacher(s) and the sending student.
 * - DIRECT (teacher → one student): the teacher(s) and that student.
 *
 * Returns LiveKit identities for `destinationIdentities`. Never returns an
 * empty list for a scoped message by accident: an empty destination list would
 * mean "everyone" to LiveKit, so callers must skip sending when it is empty.
 */
export type ChatScope = 'BROADCAST' | 'TEACHER' | 'DIRECT';

export type AudiencePerson = {
  id: string;
  role: 'TEACHER' | 'STUDENT';
  livekitIdentity: string;
};

export function chatAudience(
  msg: { scope: ChatScope; senderParticipantId: string; recipientParticipantId: string | null },
  people: AudiencePerson[]
): string[] {
  const out = new Set<string>();
  for (const p of people) {
    if (msg.scope === 'BROADCAST') {
      out.add(p.livekitIdentity);
    } else if (p.role === 'TEACHER') {
      out.add(p.livekitIdentity);
    } else if (msg.scope === 'TEACHER' && p.id === msg.senderParticipantId) {
      out.add(p.livekitIdentity);
    } else if (msg.scope === 'DIRECT' && p.id === msg.recipientParticipantId) {
      out.add(p.livekitIdentity);
    }
  }
  return Array.from(out);
}

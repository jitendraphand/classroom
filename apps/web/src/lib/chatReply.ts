/** Pure chat helpers (teacher Reply / sticky recipient), unit-tested. */

type ReplyMsg = {
  scope: string;
  senderParticipantId: string;
  recipientParticipantId: string | null;
  senderRole: string;
};

/**
 * Pure: who a teacher's Reply on this message goes to. A student's note to
 * the teacher replies to that student; the teacher's own DM replies to its
 * recipient (continue the conversation). Broadcasts have no single target.
 */
export function replyTargetFor(
  m: ReplyMsg,
  myParticipantId: string | null
): string | null {
  if (m.scope === 'TEACHER' && m.senderParticipantId !== myParticipantId) return m.senderParticipantId;
  if (m.scope === 'DIRECT') {
    if (m.senderParticipantId === myParticipantId) return m.recipientParticipantId ?? null;
    if (m.senderRole === 'STUDENT') return m.senderParticipantId;
  }
  return null;
}

/** Pure: keep the chosen recipient only while that student is still in class. */
export function resolveChatRecipient(to: 'all' | string, studentIds: Set<string>): 'all' | string {
  if (to === 'all') return 'all';
  return studentIds.has(to) ? to : 'all';
}


/** Teacher Reply and sticky recipient. Same rules as the website chat. */

type ReplyMsg = {
  scope: string;
  senderParticipantId: string;
  recipientParticipantId: string | null;
  senderRole: string;
};

/**
 * Who a teacher's Reply on this message goes to.
 * A student's note to the teacher replies to that student.
 * The teacher's own DM replies to its recipient.
 * Broadcasts have no single target.
 */
export function replyTargetFor(m: ReplyMsg, myParticipantId: string | null): string | null {
  if (m.scope === 'TEACHER' && m.senderParticipantId !== myParticipantId) return m.senderParticipantId;
  if (m.scope === 'DIRECT') {
    if (m.senderParticipantId === myParticipantId) return m.recipientParticipantId ?? null;
    if (m.senderRole === 'STUDENT') return m.senderParticipantId;
  }
  return null;
}

/** Keep the chosen recipient only while that student is still in class. */
export function resolveChatRecipient(to: 'all' | string, studentIds: Set<string>): 'all' | string {
  if (to === 'all') return 'all';
  return studentIds.has(to) ? to : 'all';
}

/**
 * Which recipient the chat dropdown shows after a paint.
 * Reply writes the class view first. A paint that prefers the old select
 * value puts the dropdown back on Everyone.
 */
export function stickyChatRecipient(viewChatTo: string, selectValue: string): string {
  return viewChatTo || selectValue || 'all';
}

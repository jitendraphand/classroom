import { ensureRedis, keys } from './redis';

export type ChatPush = {
  message: {
    id: string;
    scope: string;
    senderParticipantId: string;
    recipientParticipantId: string | null;
    [key: string]: unknown;
  };
  /** Participant ids allowed to read this message (students); ['*'] = every admitted viewer. Teachers always may. */
  participantIds: string[];
};

export async function publishChat(code: string, message: ChatPush['message'], participantIds: string[]) {
  const redis = await ensureRedis();
  const payload: ChatPush = { message, participantIds };
  await redis.publish(keys.chatChannel(code), JSON.stringify(payload));
}

export function chatVisibleTo(push: ChatPush, viewer: { isTeacher: boolean; participantId: string | null }) {
  if (viewer.isTeacher) return true;
  if (push.participantIds.includes('*')) return true;
  return !!viewer.participantId && push.participantIds.includes(viewer.participantId);
}

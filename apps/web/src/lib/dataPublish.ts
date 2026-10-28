import { ConnectionState, type Room } from 'livekit-client';

/**
 * May this client publish LiveKit data right now? Only the teacher holds the
 * data grant (lib/livekit classroomGrant): students send strokes, whiteboard
 * ops, chat and hands through the web server, which checks the permission
 * and relays them as server-originated packets.
 */
export function canPublishRoomData(room: Room | null | undefined): room is Room {
  return !!room && room.state === ConnectionState.Connected && room.localParticipant.permissions?.canPublishData === true;
}

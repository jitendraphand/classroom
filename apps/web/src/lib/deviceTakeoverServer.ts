import type { Participant, Room } from '@prisma/client';
import { prisma } from './db';
import { generateSessionToken } from './codes';
import { ensureRedis, keys } from './redis';
import { nudgeRoomState } from './roomNudge';
import { REPLACED_TOKEN_TTL_S, TAKEOVER_LIST_MAX, parseTakeovers, type TakeoverNotice } from './deviceTakeover';

/**
 * The newer device takes the seat: new session token for it, the old token is
 * remembered as replaced, and the teacher is told. The old device's LiveKit
 * connection is dropped by LiveKit itself (same identity) as soon as the new
 * one connects; until then its next API call answers `replaced: true`.
 */
export async function takeOverSeat<P extends Participant>(room: Pick<Room, 'code'>, seat: P): Promise<P> {
  const oldToken = seat.sessionToken;
  const updated = await prisma.participant.update({ where: { id: seat.id }, data: { sessionToken: generateSessionToken() } });
  try {
    const redis = await ensureRedis();
    const notice: TakeoverNotice = { participantId: seat.id, displayName: seat.displayName, at: Date.now() };
    await redis
      .multi()
      .set(keys.replacedToken(oldToken), '1', 'EX', REPLACED_TOKEN_TTL_S)
      .lpush(keys.takeovers(room.code), JSON.stringify(notice))
      .ltrim(keys.takeovers(room.code), 0, TAKEOVER_LIST_MAX - 1)
      .expire(keys.takeovers(room.code), 60 * 60 * 6)
      .exec();
  } catch (e) {
    console.warn('takeover bookkeeping failed', e instanceof Error ? e.message : e);
  }
  nudgeRoomState(room.code, 'teacher');
  return { ...seat, ...updated };
}

export async function wasReplaced(token: string | null | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    const redis = await ensureRedis();
    return (await redis.get(keys.replacedToken(token))) === '1';
  } catch {
    return false;
  }
}

export async function recentTakeovers(code: string): Promise<TakeoverNotice[]> {
  try {
    const redis = await ensureRedis();
    return parseTakeovers(await redis.lrange(keys.takeovers(code), 0, TAKEOVER_LIST_MAX - 1), Date.now());
  } catch {
    return [];
  }
}

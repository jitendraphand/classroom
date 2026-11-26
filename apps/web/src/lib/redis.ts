import Redis from 'ioredis';

const globalForRedis = globalThis as unknown as { redis?: Redis };

function createRedis() {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const client = new Redis(url, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
  client.on('error', (err) => {
    console.error('[redis]', err.message);
  });
  return client;
}

export const redis = globalForRedis.redis ?? createRedis();

if (process.env.NODE_ENV !== 'production') globalForRedis.redis = redis;

export async function ensureRedis() {
  if (redis.status === 'wait' || redis.status === 'end') {
    await redis.connect();
  }
  return redis;
}

/** Room presence + sample keys */
export const keys = {
  waiting: (code: string) => `room:${code}:waiting`,
  admitted: (code: string) => `room:${code}:admitted`,
  visible: (code: string) => `room:${code}:visible`,
  muted: (code: string) => `room:${code}:muted`,
  rotation: (code: string) => `room:${code}:rotation`,
  /** Teacher's current student-video page (0-based; lib/videoPages). */
  videoPage: (code: string) => `room:${code}:video-page`,
  /** JSON page summary for the teacher's panel ({ page, pages, total, order }). */
  videoPageInfo: (code: string) => `room:${code}:video-page-info`,
  /** Latest slide snapshot (binary image) for audio-only students (lib/slideSnapshot). */
  snapshot: (code: string) => `room:${code}:snapshot`,
  /** JSON { ver, type } of the latest snapshot. */
  snapshotMeta: (code: string) => `room:${code}:snapshot-meta`,
  /** Short coalescing marker: a page recompute after camera changes is already scheduled. */
  videoPageRefresh: (code: string) => `room:${code}:video-page-refresh`,
  /** Exclusive presentation stage: idle | screen */
  stage: (code: string) => `room:${code}:stage`,
  /** '1' while the teacher's share draws student ink on the real desktop (Windows app). */
  desktopInk: (code: string) => `room:${code}:desktop-ink`,
  /** '0' while the teacher's student-video panel is minimized/closed (cameras on demand). */
  videoPanel: (code: string) => `room:${code}:video-panel`,
  /** Legacy (speaker pins, removed 2026-11-26): only cleared when a room reopens. */
  pinnedSpeakers: (code: string) => `room:${code}:pinned-speakers`,
  /** Short-lived mutex so only one client rotates the visible sample */
  rotateLock: (code: string) => `room:${code}:rotate-lock`,
  /** Hash participant id → JSON focus status (fullscreen / left / away / unsupported) */
  focus: (code: string) => `room:${code}:focus`,
  /** Set of participant ids with raised hands */
  hands: (code: string) => `room:${code}:hands`,
  /** Hash participant id -> ms when the hand went up (roster order). Kept beside `hands`. */
  handsAt: (code: string) => `room:${code}:hands-at`,
  /** Student drawing on the share: hash participant id -> ms of the request. */
  drawRequests: (code: string) => `room:${code}:draw-req`,
  /** JSON DrawHolder: the ONE student allowed to draw now (with its end time). */
  drawHolder: (code: string) => `room:${code}:draw-holder`,
  /** Hash participantId -> DrawHolder JSON (several students may draw at once). */
  drawHolders: (code: string) => `room:${code}:draw-holders`,
  /** Hash stroke id -> JSON Stroke, and the drawing order (list of ids). */
  drawStrokes: (code: string) => `room:${code}:draw-strokes`,
  drawOrder: (code: string) => `room:${code}:draw-order`,
  /** Student LiveKit presence: hash identity -> JSON {sid, gone?: ms} (lib/studentPresence). */
  studentLive: (code: string) => `room:${code}:student-live`,
  /** Student heartbeat: hash identity -> last beat ms. Missing is not stale. */
  studentHb: (code: string) => `room:${code}:student-hb`,
  /** Student camera as reported by their client: hash identity -> '1' on / '0' off (lib/studentCamera). */
  studentCam: (code: string) => `room:${code}:student-cam`,
  /** JSON {s: sessionId, p: boolean}: is the teacher connected to the LiveKit room (webhook / probe) */
  teacherPresent: (code: string) => `room:${code}:teacher-present`,
  /** '1': this student session token was taken over by another device (lib/deviceTakeover). */
  replacedToken: (token: string) => `student-token:${token}:replaced`,
  /** List of JSON TakeoverNotice for the teacher's toast (newest first). */
  takeovers: (code: string) => `room:${code}:takeovers`,
  /** JSON MicBook: open student mics and the speak queue. */
  micBook: (code: string) => `room:${code}:mic-book`,
  /** SET of room codes whose mic book has a granted-but-unused slot (idle sweep). */
  micPendingRooms: () => `mic-pending:rooms`,
  /** Participant id the teacher is spotlighting, or absent. */
  spotlight: (code: string) => `room:${code}:spotlight`,
  /** Hash adminobserver identity -> expiresAt ms for active live observers. */
  observers: (code: string) => `room:${code}:observers`,
  /** '1' while at least one admin observer is active in this room. */
  observerMarker: (code: string) => `room:${code}:observer-active`,
  /** Redis pub/sub channel for chat SSE (not a stored key). */
  chatChannel: (code: string) => `room:${code}:chat`,
  /** Sorted set score=due-ms member=`code|sessionId` for teacher-absence grace. */
  teacherAbsenceDue: () => `teacher-absence:due`,
  /** SET NX lock: weekly rank snapshots run on one worker. */
  leaderRank: () => `leader:rank-scheduler`,
  /**
   * Who ended this room session ('admin' | 'teacher'). Kept after clearRoomRedis
   * so /state can tell the teacher; keyed by sessionId because rooms are reused.
   */
  endedBy: (code: string, sessionId: string) => `ended-by:${code}:${sessionId}`,
  /** Append-only audit event list (JSON lines), newest first. */
  auditEvents: () => `audit:events`,
};

export type StageMode = 'idle' | 'screen';

/**
 * Keys left behind by the removed whiteboard feature. Only deleted (on end /
 * reopen) so old deployments do not leak them; nothing reads or writes them.
 * Safe to drop after one release.
 */
export const legacyKeys = (code: string) => [
  `room:${code}:whiteboard`,
  `room:${code}:wb-write`,
  // Screen annotation layer (feature removed).
  `room:${code}:screen-annotate`,
];


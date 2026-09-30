import {
  AccessToken,
  DataPacket_Kind,
  RoomServiceClient,
  TrackSource,
  TrackType,
} from 'livekit-server-sdk';
import { prisma } from './db';
import { resolvePublicLiveKitUrl } from './url';
import { isTeacherPresent } from './teacherPresence';
import { studentMicAllowed } from './teacherPresenceLogic';

/**
 * LiveKit access-token lifetime. Short on purpose: LiveKit refreshes the token
 * of a connected participant automatically, so this only bounds how long a
 * token copied out of a browser (or kept by a removed student) stays usable.
 */
export const LIVEKIT_TOKEN_TTL = '10m';

export function getLiveKitHttpUrl() {
  return (
    process.env.LIVEKIT_INTERNAL_URL ||
    process.env.LIVEKIT_URL?.replace(/^ws/, 'http') ||
    'http://localhost:7880'
  );
}

export function getPublicLiveKitUrl(req?: Request) {
  return resolvePublicLiveKitUrl(req);
}

export function roomService() {
  const key = process.env.LIVEKIT_API_KEY!;
  const secret = process.env.LIVEKIT_API_SECRET!;
  return new RoomServiceClient(getLiveKitHttpUrl(), key, secret);
}

/**
 * Publishable sources are the server-side enforcement of the two rules the
 * classroom depends on: only the visible sample may publish camera, and a
 * teacher-muted student may not publish microphone. The client mirrors both for
 * UI only — the grant here is the source of truth.
 */
export type PublishPermissions = {
  /** May publish a camera track (true for teachers + students in the sample). */
  allowCamera: boolean;
  /** May publish a microphone track (false while teacher-muted). */
  allowMic: boolean;
  /** May publish a screen share. Teachers only; students never get it. */
  allowScreen?: boolean;
};

/**
 * Sources to allow for a permission set. Students get at most camera +
 * microphone: they have no screen-share UI, and a modified client must not be
 * able to push a screen share into the teacher's view.
 */
export function publishSourcesFor({
  allowCamera,
  allowMic,
  allowScreen = false,
}: PublishPermissions): TrackSource[] {
  const out: TrackSource[] = [];
  if (allowCamera) out.push(TrackSource.CAMERA);
  if (allowMic) out.push(TrackSource.MICROPHONE);
  if (allowScreen) out.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
  return out;
}

export type ParticipantGrantInput = {
  role: 'TEACHER' | 'STUDENT';
  roomName: string;
  /** Student outside the visible sample → no camera. Ignored for teachers. */
  allowCamera?: boolean;
  /** Teacher-muted student → no microphone. Ignored for teachers. */
  mutedByTeacher?: boolean;
  /**
   * Teacher is not connected to the LiveKit room → student gets no microphone
   * (force-muted until the teacher is back). Ignored for teachers.
   */
  micLocked?: boolean;
};

/**
 * The LiveKit video grant for a classroom participant. Pure so it can be
 * unit-tested.
 *
 * - Teacher: publish every source, publish data (annotation strokes).
 * - Student: publish camera (only while in the sample) and microphone (only
 *   while not teacher-muted); **no data publishing** (chat and annotations
 *   reach students from the server / teacher only) and **no screen share**.
 */
export function classroomGrant(input: ParticipantGrantInput) {
  const isTeacher = input.role === 'TEACHER';
  const sources = isTeacher
    ? publishSourcesFor({ allowCamera: true, allowMic: true, allowScreen: true })
    : publishSourcesFor({
        allowCamera: input.allowCamera ?? false,
        allowMic: studentMicAllowed({
          mutedByTeacher: !!input.mutedByTeacher,
          teacherPresent: !input.micLocked,
        }),
      });
  return {
    roomJoin: true,
    room: input.roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: isTeacher,
    canPublishSources: sources,
  };
}

export async function createParticipantToken(
  opts: ParticipantGrantInput & {
    identity: string;
    name: string;
    metadata?: Record<string, unknown>;
  }
) {
  const at = new AccessToken(process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!, {
    identity: opts.identity,
    name: opts.name,
    metadata: opts.metadata ? JSON.stringify(opts.metadata) : undefined,
    ttl: LIVEKIT_TOKEN_TTL,
  });
  at.addGrant(classroomGrant(opts));
  return at.toJwt();
}

/**
 * LiveKit room name for one class session. The session id rotates whenever
 * the teacher's permanent room is reopened, so a token from a previous class
 * (same code) names a different LiveKit room and cannot join this one.
 */
export function livekitRoomName(code: string, sessionId: string) {
  return `classroom_${code}_${sessionId}`;
}

/** Current LiveKit room name for a class code, or null when the room is unknown. */
export async function livekitRoomNameForCode(code: string): Promise<string | null> {
  const room = await prisma.room.findUnique({
    where: { code },
    select: { code: true, sessionId: true },
  });
  return room ? livekitRoomName(room.code, room.sessionId) : null;
}

/**
 * Disconnect one participant from the SFU (teacher removed them, or they
 * left). Without this a removed student keeps receiving media until they
 * close the tab. Best effort: they may already be gone.
 */
export async function removeLiveKitParticipant(roomName: string, identity: string) {
  try {
    await roomService().removeParticipant(roomName, identity);
  } catch (e) {
    // NOT_FOUND when the participant is not connected — nothing to do.
    const msg = e instanceof Error ? e.message : String(e);
    if (!/not.?found|does not exist/i.test(msg)) {
      console.warn('LiveKit removeParticipant', identity, msg);
    }
  }
}

/**
 * Server-originated data packet. Used for chat so message bodies only reach
 * the participants allowed to read them (`destinationIdentities`), and so a
 * client can trust a chat packet because only the server can send one
 * (students have no data-publish grant).
 */
export async function sendRoomData(
  roomName: string,
  payload: unknown,
  opts: { topic: string; destinationIdentities?: string[] }
) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  try {
    await roomService().sendData(roomName, bytes, DataPacket_Kind.RELIABLE, {
      topic: opts.topic,
      destinationIdentities: opts.destinationIdentities,
    });
  } catch (e) {
    // Room not created yet (nobody connected) — clients still poll /messages.
    console.warn('LiveKit sendData', opts.topic, e instanceof Error ? e.message : e);
  }
}

/**
 * Server-side force of a participant's publish permissions via LiveKit.
 *
 * Updates the participant permission AND mutes any already-published track that
 * the new permissions no longer allow, so a client that ignores the grant stops
 * sending immediately rather than at its next token refresh.
 *
 * Both flags are always sent together: writing canPublishSources is a full
 * replacement, so a mic-only update would silently re-grant camera.
 */
export async function setParticipantPublishPermissions(
  code: string,
  identity: string,
  requested: PublishPermissions,
  opts: { teacherPresent?: boolean } = {}
): Promise<void> {
  const svc = roomService();
  const roomName = await livekitRoomNameForCode(code);
  if (!roomName) return;
  // Students are force-muted while the teacher is not connected, whatever the
  // caller asked for (sample rotation, "Unmute all", …). The teacher's own mute
  // state is already folded into requested.allowMic.
  const teacherPresent = opts.teacherPresent ?? (await isTeacherPresent(code));
  const perms: PublishPermissions = {
    ...requested,
    allowMic: studentMicAllowed({ mutedByTeacher: !requested.allowMic, teacherPresent }),
  };
  // Only ever called for students: never re-grant data publishing or screen share.
  const allowed = publishSourcesFor({ allowCamera: perms.allowCamera, allowMic: perms.allowMic });

  try {
    await svc.updateParticipant(roomName, identity, {
      permission: {
        canPublish: true,
        canSubscribe: true,
        canPublishData: false,
        canPublishSources: allowed,
      },
    });
  } catch (e) {
    // Participant may not be connected yet — the token grant and the DB/Redis
    // flags still apply when they (re)connect.
    console.warn('LiveKit updateParticipant publish permissions', identity, e);
    return;
  }

  // Mute any track that is no longer permitted.
  const toMute: TrackSource[] = [];
  if (!perms.allowCamera) toMute.push(TrackSource.CAMERA);
  if (!perms.allowMic) toMute.push(TrackSource.MICROPHONE);
  if (!toMute.length) return;

  try {
    const participants = await svc.listParticipants(roomName);
    const p = participants.find((x) => x.identity === identity);
    if (!p?.tracks) return;
    for (const t of p.tracks) {
      if (!t.sid) continue;
      const isMic =
        t.source === TrackSource.MICROPHONE ||
        (t.type === TrackType.AUDIO && t.source !== TrackSource.SCREEN_SHARE_AUDIO);
      const isCam = t.source === TrackSource.CAMERA;
      const shouldMute =
        (isMic && toMute.includes(TrackSource.MICROPHONE)) ||
        (isCam && toMute.includes(TrackSource.CAMERA));
      if (!shouldMute) continue;
      try {
        await svc.mutePublishedTrack(roomName, identity, t.sid, true);
      } catch (err) {
        console.warn('LiveKit mutePublishedTrack', identity, t.sid, err);
      }
    }
  } catch (e) {
    console.warn('LiveKit listParticipants/mute', identity, e);
  }
}

/**
 * Force mute/unmute of a student microphone.
 * `allowCamera` must be the identity's current sample membership so this does
 * not re-grant camera to a student outside the visible sample.
 */
export async function setParticipantMicAllowed(
  code: string,
  identity: string,
  allowed: boolean,
  allowCamera = true
): Promise<void> {
  await setParticipantPublishPermissions(code, identity, { allowCamera, allowMic: allowed });
}

/** Force camera on/off for one identity (rotation in/out of the visible sample). */
export async function setParticipantCameraAllowed(
  code: string,
  identity: string,
  allowed: boolean,
  allowMic = true
): Promise<void> {
  await setParticipantPublishPermissions(code, identity, { allowCamera: allowed, allowMic });
}

export async function setManyParticipantMics(
  code: string,
  identities: string[],
  allowed: boolean,
  inSample: (identity: string) => boolean = () => true
): Promise<void> {
  await Promise.allSettled(
    identities.map((id) => setParticipantMicAllowed(code, id, allowed, inSample(id)))
  );
}

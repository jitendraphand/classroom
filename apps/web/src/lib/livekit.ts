import {
  AccessToken,
  RoomServiceClient,
  TrackSource,
  TrackType,
} from 'livekit-server-sdk';
import { resolvePublicLiveKitUrl } from './url';

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
};

const ALL_TRACK_SOURCES = [
  TrackSource.CAMERA,
  TrackSource.MICROPHONE,
  TrackSource.SCREEN_SHARE,
  TrackSource.SCREEN_SHARE_AUDIO,
];

/** Sources to allow for a permission pair. */
export function publishSourcesFor({ allowCamera, allowMic }: PublishPermissions): TrackSource[] {
  return ALL_TRACK_SOURCES.filter((source) => {
    if (source === TrackSource.CAMERA) return allowCamera;
    if (source === TrackSource.MICROPHONE) return allowMic;
    return true;
  });
}

export async function createParticipantToken(opts: {
  roomName: string;
  identity: string;
  name: string;
  canPublish: boolean;
  canPublishData?: boolean;
  canSubscribe?: boolean;
  /** When true, JWT omits microphone from publishable sources */
  mutedByTeacher?: boolean;
  /** When false, JWT omits camera — student is outside the visible sample. */
  allowCamera?: boolean;
  metadata?: Record<string, unknown>;
}) {
  const at = new AccessToken(process.env.LIVEKIT_API_KEY!, process.env.LIVEKIT_API_SECRET!, {
    identity: opts.identity,
    name: opts.name,
    metadata: opts.metadata ? JSON.stringify(opts.metadata) : undefined,
    ttl: '6h',
  });

  const grant: Parameters<typeof at.addGrant>[0] = {
    roomJoin: true,
    room: opts.roomName,
    canPublish: opts.canPublish,
    canSubscribe: opts.canSubscribe ?? true,
    canPublishData: opts.canPublishData ?? true,
  };

  if (opts.canPublish) {
    const perms: PublishPermissions = {
      allowCamera: opts.allowCamera ?? true,
      allowMic: !opts.mutedByTeacher,
    };
    // Leave canPublishSources unset when everything is allowed so the grant
    // keeps LiveKit's default (all sources) rather than pinning a subset.
    if (!perms.allowCamera || !perms.allowMic) {
      grant.canPublishSources = publishSourcesFor(perms);
    }
  }

  at.addGrant(grant);

  return at.toJwt();
}

export function livekitRoomName(code: string) {
  return `classroom_${code}`;
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
  perms: PublishPermissions
): Promise<void> {
  const svc = roomService();
  const roomName = livekitRoomName(code);
  const allowed = publishSourcesFor(perms);

  try {
    await svc.updateParticipant(roomName, identity, {
      permission: {
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
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

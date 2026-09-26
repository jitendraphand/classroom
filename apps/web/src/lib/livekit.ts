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

/** Sources allowed when teacher has muted the student mic */
const SOURCES_NO_MIC = [
  TrackSource.CAMERA,
  TrackSource.SCREEN_SHARE,
  TrackSource.SCREEN_SHARE_AUDIO,
];

export async function createParticipantToken(opts: {
  roomName: string;
  identity: string;
  name: string;
  canPublish: boolean;
  canPublishData?: boolean;
  canSubscribe?: boolean;
  /** When true, JWT omits microphone from publishable sources */
  mutedByTeacher?: boolean;
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

  if (opts.canPublish && opts.mutedByTeacher) {
    grant.canPublishSources = SOURCES_NO_MIC;
  }

  at.addGrant(grant);

  return at.toJwt();
}

export function livekitRoomName(code: string) {
  return `classroom_${code}`;
}

/**
 * Server-side force mute/unmute of student microphone via LiveKit.
 * Updates publish permissions and mutes any already-published audio tracks.
 */
export async function setParticipantMicAllowed(
  code: string,
  identity: string,
  allowed: boolean
): Promise<void> {
  const svc = roomService();
  const roomName = livekitRoomName(code);

  try {
    if (allowed) {
      // Clear source restriction — canPublish true allows all sources again
      await svc.updateParticipant(roomName, identity, {
        permission: {
          canPublish: true,
          canSubscribe: true,
          canPublishData: true,
          canPublishSources: [
            TrackSource.CAMERA,
            TrackSource.MICROPHONE,
            TrackSource.SCREEN_SHARE,
            TrackSource.SCREEN_SHARE_AUDIO,
          ],
        },
      });
    } else {
      await svc.updateParticipant(roomName, identity, {
        permission: {
          canPublish: true,
          canSubscribe: true,
          canPublishData: true,
          canPublishSources: SOURCES_NO_MIC,
        },
      });
    }
  } catch (e) {
    // Participant may not be connected yet — DB/redis flag still applies on next token
    console.warn('LiveKit updateParticipant mic', identity, e);
  }

  if (allowed) return;

  try {
    const participants = await svc.listParticipants(roomName);
    const p = participants.find((x) => x.identity === identity);
    if (!p?.tracks) return;
    for (const t of p.tracks) {
      const isMic =
        t.source === TrackSource.MICROPHONE ||
        (t.type === TrackType.AUDIO && t.source !== TrackSource.SCREEN_SHARE_AUDIO);
      if (!isMic || !t.sid) continue;
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

export async function setManyParticipantMics(
  code: string,
  identities: string[],
  allowed: boolean
): Promise<void> {
  await Promise.allSettled(identities.map((id) => setParticipantMicAllowed(code, id, allowed)));
}

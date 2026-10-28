import {
  AccessToken,
  DataPacket_Kind,
  RoomServiceClient,
  TrackSource,
  TrackType,
} from 'livekit-server-sdk';
import { prisma } from './db';
import { ensureRedis, keys } from './redis';
import { resolvePublicLiveKitUrl } from './url';
import { isTeacherPresent } from './teacherPresence';
import { studentMicAllowed } from './teacherPresenceLogic';
import { mediaServers, serverForRoom, type MediaServer } from './mediaServers';
import { forgetMemo, memo } from './roomStateCache';

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

const services = new Map<string, RoomServiceClient>();
/** RoomServiceClient for one media node (cached). */
export function roomServiceOn(server: MediaServer): RoomServiceClient {
  if (mediaServers().length === 1 && server.id === 'default') return roomService();
  let svc = services.get(server.id);
  if (!svc) {
    svc = new RoomServiceClient(server.httpUrl, server.apiKey, server.apiSecret);
    services.set(server.id, svc);
  }
  return svc;
}

/** RoomServiceClient for the media node that hosts this LiveKit room. */
export async function roomServiceFor(roomName: string): Promise<RoomServiceClient> {
  return roomServiceOn(await serverForRoom(roomName));
}

/** Browser URL of the media node hosting this room (N=1: unchanged request-based URL). */
export async function mediaUrlForRoom(roomName: string, req?: Request): Promise<string> {
  const s = await serverForRoom(roomName);
  return s.url ?? resolvePublicLiveKitUrl(req);
}

async function signerFor(roomName: string): Promise<{ key: string; secret: string }> {
  const s = await serverForRoom(roomName);
  return { key: s.apiKey || process.env.LIVEKIT_API_KEY!, secret: s.apiSecret || process.env.LIVEKIT_API_SECRET! };
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
 * - Teacher: publish every source, plus data (whiteboard, chat fan-out, signals).
 * - Student: publish camera (only while in the sample) and microphone (only
 *   while not teacher-muted); **no data publishing** (strokes, whiteboard ops,
 *   chat and hands go through the web server, which checks the draw permission
 *   and stamps the sender) and **no screen share**.
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
    ...publishPermission(sources),
    canSubscribe: true,
    canPublishData: isTeacher,
  };
}

/**
 * `canPublish` + `canPublishSources` for a source list. LiveKit treats an
 * EMPTY `canPublishSources` as "every source allowed" (livekit-client mirrors
 * the server: `canPublishSources.length === 0 || includes(source)`), so
 * "nothing" must be `canPublish: false`, never `canPublish: true` with `[]`.
 */
export function publishPermission(sources: TrackSource[]): { canPublish: boolean; canPublishSources: TrackSource[] } {
  return sources.length ? { canPublish: true, canPublishSources: sources } : { canPublish: false, canPublishSources: [] };
}

export async function createParticipantToken(
  opts: ParticipantGrantInput & {
    identity: string;
    name: string;
    metadata?: Record<string, unknown>;
  }
) {
  const signer = await signerFor(opts.roomName);
  const at = new AccessToken(signer.key, signer.secret, {
    identity: opts.identity,
    name: opts.name,
    metadata: opts.metadata ? JSON.stringify(opts.metadata) : undefined,
    ttl: LIVEKIT_TOKEN_TTL,
  });
  at.addGrant(classroomGrant(opts));
  return at.toJwt();
}

/**
 * Admin observer tokens ("Ongoing classes" on /admin).
 *
 * - `preview`: the small live tile. Subscribe-only, very short TTL.
 * - `observe`: the admin sitting in the class (listen/watch only).
 *
 * Both are `hidden` (no participant-joined broadcast, not in anyone's
 * participant list → never in the teacher's mosaic or a student's roster, never
 * counted by attendance, which only tracks `student_` identities) and can
 * publish nothing — no media, no data, no metadata. LiveKit grants cannot
 * restrict *which* tracks a subscriber may take; student tracks are protected
 * by the students' own per-track subscription permissions (StudentMediaPrivacy
 * allows only participants they can see, and a hidden participant is not one).
 */
export type ObserverMode = 'preview' | 'observe';
export const OBSERVER_PREVIEW_TTL = '2m';
export const OBSERVER_TOKEN_TTL = '10m';

export function observerGrant(roomName: string) {
  return {
    roomJoin: true,
    room: roomName,
    canPublish: false,
    canPublishData: false,
    canPublishSources: [] as TrackSource[],
    canSubscribe: true,
    canUpdateOwnMetadata: false,
    hidden: true,
  };
}

/** Never `teacher_…` / `student_…`, so no classroom logic mistakes it for either role. */
export function observerIdentity(adminId: string, mode: ObserverMode, nonce: string) {
  return `${mode === 'preview' ? 'adminpreview' : 'adminobserver'}_${adminId}_${nonce}`;
}

export async function createObserverToken(opts: {
  roomName: string;
  adminId: string;
  adminName: string;
  mode: ObserverMode;
  nonce?: string;
}) {
  const identity = observerIdentity(
    opts.adminId,
    opts.mode,
    opts.nonce ?? crypto.randomUUID().replace(/-/g, '').slice(0, 10)
  );
  const signer = await signerFor(opts.roomName);
  const at = new AccessToken(signer.key, signer.secret, {
    identity,
    name: opts.mode === 'preview' ? 'Admin preview' : opts.adminName || 'School admin',
    metadata: JSON.stringify({ role: 'ADMIN', mode: opts.mode }),
    ttl: opts.mode === 'preview' ? OBSERVER_PREVIEW_TTL : OBSERVER_TOKEN_TTL,
  });
  at.addGrant(observerGrant(opts.roomName));
  return { token: await at.toJwt(), identity };
}

/**
 * LiveKit room name for one class session. The session id rotates whenever
 * the teacher's permanent room is reopened, so a token from a previous class
 * (same code) names a different LiveKit room and cannot join this one.
 */
export function livekitRoomName(code: string, sessionId: string) {
  return `classroom_${code}_${sessionId}`;
}

/**
 * Current LiveKit room name for a class code, or null when the room is unknown.
 * Shared for a few seconds per worker: every relayed stroke / whiteboard op /
 * nudge needs it, and it only changes when the room is reopened (which calls
 * forgetLivekitRoomName).
 */
export async function livekitRoomNameForCode(code: string): Promise<string | null> {
  return memo(roomNameKey(code), ROOM_NAME_TTL_MS, async () => {
    const room = await prisma.room.findUnique({
      where: { code },
      select: { code: true, sessionId: true },
    });
    return room ? livekitRoomName(room.code, room.sessionId) : null;
  });
}

const ROOM_NAME_TTL_MS = 3_000;
const roomNameKey = (code: string) => `lk-room-name:${code}`;

export function forgetLivekitRoomName(code: string) {
  forgetMemo(roomNameKey(code));
}

/**
 * Disconnect one participant from the SFU (teacher removed them, or they
 * left). Without this a removed student keeps receiving media until they
 * close the tab. Best effort: they may already be gone.
 */
export async function removeLiveKitParticipant(roomName: string, identity: string) {
  try {
    await (await roomServiceFor(roomName)).removeParticipant(roomName, identity);
  } catch (e) {
    // NOT_FOUND when the participant is not connected — nothing to do.
    const msg = e instanceof Error ? e.message : String(e);
    if (!/not.?found|does not exist/i.test(msg)) {
      console.warn('LiveKit removeParticipant', identity, msg);
    }
  }
}

/**
 * Server-originated data packet: chat (with destinationIdentities), mute,
 * state nudges, and every student-originated stroke / whiteboard op / hand
 * (students cannot publish data themselves). Clients also accept packets from
 * the teacher's identity.
 */
export async function sendRoomData(
  roomName: string,
  payload: unknown,
  opts: { topic: string; destinationIdentities?: string[] }
) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  try {
    await (await roomServiceFor(roomName)).sendData(roomName, bytes, DataPacket_Kind.RELIABLE, {
      topic: opts.topic,
      destinationIdentities: opts.destinationIdentities,
    });
  } catch (e) {
    // Room not created yet (nobody connected) — clients still poll /messages.
    console.warn('LiveKit sendData', opts.topic, e instanceof Error ? e.message : e);
  }
}

/**
 * Shared per-room context for permission pushes: resolved once per batch,
 * not once per student (a teacher reconnect in a 1,000-student class used to
 * repeat the room lookup, presence check and spotlight lookup 1,000 times).
 */
export type PermissionContext = {
  code: string;
  roomName: string;
  svc: RoomServiceClient;
  teacherPresent: boolean;
  /** LiveKit identity of the spotlighted student (keeps their camera grant), or null. */
  spotlightIdentity: string | null;
};

async function spotlightIdentityFor(code: string): Promise<string | null> {
  try {
    const id = await (await ensureRedis()).get(keys.spotlight(code));
    if (!id) return null;
    const part = await prisma.participant.findFirst({
      where: { id, role: 'STUDENT' },
      select: { livekitIdentity: true },
    });
    return part?.livekitIdentity ?? null;
  } catch {
    return null;
  }
}

export async function permissionContext(
  code: string,
  opts: { teacherPresent?: boolean; room?: { code: string; sessionId: string } | null } = {}
): Promise<PermissionContext | null> {
  const room =
    opts.room ?? (await prisma.room.findUnique({ where: { code }, select: { code: true, sessionId: true } }));
  if (!room) return null;
  const roomName = livekitRoomName(room.code, room.sessionId);
  const [svc, teacherPresent, spotlightIdentity] = await Promise.all([
    roomServiceFor(roomName),
    opts.teacherPresent ?? isTeacherPresent(code, room),
    spotlightIdentityFor(code),
  ]);
  return { code, roomName, svc, teacherPresent, spotlightIdentity };
}

export type StudentPublishRequest = { identity: string } & PublishPermissions;

/** Effective sources for one student: teacher absence locks the mic, spotlight keeps the camera. */
export function effectiveStudentSources(
  req: StudentPublishRequest,
  ctx: Pick<PermissionContext, 'teacherPresent' | 'spotlightIdentity'>
): { allowCamera: boolean; allowMic: boolean; sources: TrackSource[] } {
  const allowMic = studentMicAllowed({ mutedByTeacher: !req.allowMic, teacherPresent: ctx.teacherPresent });
  const allowCamera = req.allowCamera || (!!ctx.spotlightIdentity && ctx.spotlightIdentity === req.identity);
  return { allowCamera, allowMic, sources: publishSourcesFor({ allowCamera, allowMic }) };
}

/** Published tracks (from a ParticipantInfo) that the new permissions no longer allow. */
export function tracksToMute(
  tracks: { sid?: string; type?: TrackType; source?: TrackSource; muted?: boolean }[] | undefined,
  allow: { allowCamera: boolean; allowMic: boolean }
): string[] {
  const out: string[] = [];
  for (const t of tracks ?? []) {
    if (!t.sid || t.muted) continue;
    const isMic =
      t.source === TrackSource.MICROPHONE ||
      (t.type === TrackType.AUDIO && t.source !== TrackSource.SCREEN_SHARE_AUDIO);
    const isCam = t.source === TrackSource.CAMERA;
    if ((isMic && !allow.allowMic) || (isCam && !allow.allowCamera)) out.push(t.sid);
  }
  return out;
}

async function pushOne(ctx: PermissionContext, req: StudentPublishRequest): Promise<void> {
  const eff = effectiveStudentSources(req, ctx);
  let info: { tracks?: { sid?: string; type?: TrackType; source?: TrackSource; muted?: boolean }[] };
  try {
    // The response is the participant's current info (tracks included), so no
    // extra listParticipants call is needed to find tracks to mute.
    info = await ctx.svc.updateParticipant(ctx.roomName, req.identity, {
      permission: { ...publishPermission(eff.sources), canSubscribe: true, canPublishData: false },
    });
  } catch (e) {
    // Not connected (yet): the token grant and the DB/Redis flags apply when they connect.
    const msg = e instanceof Error ? e.message : String(e);
    if (!/not.?found|does not exist/i.test(msg)) console.warn('LiveKit updateParticipant', req.identity, msg);
    return;
  }
  for (const sid of tracksToMute(info.tracks, eff)) {
    try {
      await ctx.svc.mutePublishedTrack(ctx.roomName, req.identity, sid, true);
    } catch (err) {
      console.warn('LiveKit mutePublishedTrack', req.identity, sid, err instanceof Error ? err.message : err);
    }
  }
}

/** Parallel LiveKit API calls per batch (PERMISSION_PUSH_CONCURRENCY, default 8). */
export function permissionPushConcurrency(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt(env.PERMISSION_PUSH_CONCURRENCY ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 64) : 8;
}

/** Run `fn` over `items` with at most `n` in flight. */
export async function runBounded<T>(items: readonly T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, n), items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++]!;
      try {
        await fn(item);
      } catch (e) {
        console.warn('permission push', e instanceof Error ? e.message : e);
      }
    }
  });
  await Promise.all(workers);
}

/**
 * Server-side force of student publish permissions via LiveKit, for one or
 * many students. Updates each participant's permission AND mutes any
 * already-published track the new permissions no longer allow, so a client
 * that ignores the grant stops sending at once.
 *
 * Camera and mic are always sent together: writing canPublishSources is a
 * full replacement, so a mic-only update would silently re-grant camera.
 */
export async function pushStudentPermissions(
  code: string,
  requests: StudentPublishRequest[],
  opts: { teacherPresent?: boolean; room?: { code: string; sessionId: string } | null; ctx?: PermissionContext } = {}
): Promise<void> {
  const students = requests.filter((r) => r.identity.startsWith('student_'));
  if (!students.length) return;
  const ctx = opts.ctx ?? (await permissionContext(code, opts));
  if (!ctx) return;
  await runBounded(students, permissionPushConcurrency(), (r) => pushOne(ctx, r));
}

export async function setParticipantPublishPermissions(
  code: string,
  identity: string,
  requested: PublishPermissions,
  opts: { teacherPresent?: boolean } = {}
): Promise<void> {
  await pushStudentPermissions(code, [{ identity, ...requested }], opts);
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

/** One batch (shared context, bounded concurrency) for many students. */
export async function setManyParticipantMics(
  code: string,
  identities: string[],
  allowed: boolean | ((identity: string) => boolean),
  inSample: (identity: string) => boolean = () => true
): Promise<void> {
  const mic = typeof allowed === 'function' ? allowed : () => allowed;
  await pushStudentPermissions(
    code,
    identities.map((identity) => ({ identity, allowMic: mic(identity), allowCamera: inSample(identity) }))
  );
}

/**
 * Screen-share sidecar (Windows teacher app, native publisher): a second
 * participant tied to the teacher that may publish ONLY the screen share
 * (+ its audio). It subscribes to nothing and sends no data. The identity
 * keeps the `teacher_` prefix so every client treats its share as the
 * teacher's (isTeacherParticipant / isTeacherIdentity).
 */
export const SCREEN_SIDECAR_SUFFIX = '__screen';

export function screenSidecarIdentity(teacherIdentity: string) {
  return `${teacherIdentity}${SCREEN_SIDECAR_SUFFIX}`;
}

export function isScreenSidecarIdentity(identity: string) {
  return identity.startsWith('teacher_') && identity.endsWith(SCREEN_SIDECAR_SUFFIX);
}

export function screenSidecarGrant(roomName: string) {
  return {
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: false,
    canPublishData: false,
    canUpdateOwnMetadata: false,
    canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
  };
}

export async function createScreenSidecarToken(opts: { roomName: string; teacherIdentity: string; name: string; participantId: string }) {
  const identity = screenSidecarIdentity(opts.teacherIdentity);
  const signer = await signerFor(opts.roomName);
  const at = new AccessToken(signer.key, signer.secret, {
    identity,
    name: opts.name,
    metadata: JSON.stringify({ role: 'TEACHER', screenFor: opts.teacherIdentity, participantId: opts.participantId }),
    ttl: LIVEKIT_TOKEN_TTL,
  });
  at.addGrant(screenSidecarGrant(opts.roomName));
  return { token: await at.toJwt(), identity };
}

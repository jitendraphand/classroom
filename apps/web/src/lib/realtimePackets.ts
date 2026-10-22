/**
 * LiveKit data-channel topics and trust rules. High-frequency classroom
 * traffic (strokes, chat, hand, draw request) fans out through the SFU.
 * The web server still persists what late joiners need (chat history,
 * whiteboard snapshot, draw strokes) and still enforces mute-all on the
 * LiveKit server API. Clients never take a mute/hand/chat packet from an
 * identity that is not allowed to send it.
 */

export const CHAT_TOPIC = 'chat';
/** Hand raise, draw-request. Mute still uses STATE_TOPIC (`type: mute`). */
export const SIGNAL_TOPIC = 'cls-signal';

export type SenderKind = 'server' | 'teacher' | 'student' | 'other';

export function senderKind(identity: string | null | undefined): SenderKind {
  if (!identity) return 'server';
  if (identity.startsWith('teacher_') && !identity.endsWith('__screen')) return 'teacher';
  if (identity.startsWith('student_')) return 'student';
  return 'other';
}

/**
 * Chat packets. Server-originated (no identity) are always trusted. A teacher
 * may send any stored message with senderRole TEACHER. A student may only send
 * a TEACHER-scope (student → teacher) message as themselves — never a
 * broadcast or a classmate's DM.
 */
export function chatPacketTrusted(opts: {
  senderIdentity: string | null | undefined;
  message: { senderRole?: string; scope?: string; senderParticipantId?: string };
  /** When known, the participant id of `senderIdentity`. */
  identityParticipantId?: string | null;
}): boolean {
  const kind = senderKind(opts.senderIdentity);
  if (kind === 'server') return true;
  if (kind === 'other') return false;
  const role = String(opts.message.senderRole || '');
  const scope = String(opts.message.scope || '');
  if (kind === 'teacher') return role === 'TEACHER';
  if (role !== 'STUDENT' || scope !== 'TEACHER') return false;
  if (
    opts.identityParticipantId &&
    opts.message.senderParticipantId &&
    opts.identityParticipantId !== opts.message.senderParticipantId
  ) {
    return false;
  }
  return true;
}

export type SignalPacket =
  | { v: 1; type: 'hand'; raised: boolean; participantId: string }
  | { v: 1; type: 'draw-req'; on: boolean; participantId: string };

export function decodeSignalPacket(raw: unknown): SignalPacket | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (
    o.type === 'hand' &&
    typeof o.raised === 'boolean' &&
    typeof o.participantId === 'string' &&
    o.participantId.length >= 1 &&
    o.participantId.length <= 64
  ) {
    return { v: 1, type: 'hand', raised: o.raised, participantId: o.participantId };
  }
  if (
    o.type === 'draw-req' &&
    typeof o.on === 'boolean' &&
    typeof o.participantId === 'string' &&
    o.participantId.length >= 1 &&
    o.participantId.length <= 64
  ) {
    return { v: 1, type: 'draw-req', on: o.on, participantId: o.participantId };
  }
  return null;
}

/**
 * Hand / draw-request: server or teacher may name anyone; a student may only
 * name themselves (`selfParticipantId`). Mute is not on this topic.
 */
export function signalPacketTrusted(
  packet: SignalPacket,
  senderIdentity: string | null | undefined,
  selfParticipantId?: string | null
): boolean {
  const kind = senderKind(senderIdentity);
  if (kind === 'server' || kind === 'teacher') return true;
  if (kind === 'student') return !!selfParticipantId && packet.participantId === selfParticipantId;
  return false;
}

export function applyHandPush<
  T extends {
    me: { id: string; handRaised?: boolean } | null;
    admitted: { id: string; handRaised?: boolean }[];
    raisedHands?: string[];
  },
>(state: T, participantId: string, raised: boolean): T {
  const me = state.me?.id === participantId ? { ...state.me, handRaised: raised } : state.me;
  const admitted = state.admitted.map((p) => (p.id === participantId ? { ...p, handRaised: raised } : p));
  const set = new Set(state.raisedHands ?? admitted.filter((p) => p.handRaised).map((p) => p.id));
  if (raised) set.add(participantId);
  else set.delete(participantId);
  return { ...state, me, admitted, raisedHands: [...set] };
}

export function applyDrawReqPush<
  T extends {
    me: { id: string; drawRequested?: boolean } | null;
    admitted: { id: string; drawRequested?: boolean }[];
    drawRequestCount?: number;
  },
>(state: T, participantId: string, on: boolean): T {
  const me = state.me?.id === participantId ? { ...state.me, drawRequested: on } : state.me;
  const admitted = state.admitted.map((p) => (p.id === participantId ? { ...p, drawRequested: on } : p));
  return { ...state, me, admitted, drawRequestCount: admitted.filter((p) => p.drawRequested).length };
}

/** Whiteboard packets from a student identity: ops only (never end / snap / req). */
export function wbStudentPacketAllowed(t: string): boolean {
  return t === 'ops';
}

/**
 * Screen-draw overlay. Server/teacher: any packet. Student: `pts` only, and
 * `by` must equal their LiveKit identity (they cannot wipe or erase others
 * over the data channel; del/clear stay server-relayed).
 */
export function drawPacketTrusted(opts: {
  senderIdentity: string | null | undefined;
  packet: { t: string; by?: string };
}): boolean {
  const kind = senderKind(opts.senderIdentity);
  if (kind === 'server' || kind === 'teacher') return true;
  if (kind !== 'student') return false;
  return opts.packet.t === 'pts' && opts.packet.by === opts.senderIdentity;
}

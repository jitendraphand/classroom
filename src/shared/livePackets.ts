/**
 * Which LiveKit data packets the teacher app acts on, and how. Mirrors the
 * web app's trust rules (`web/realtimePackets.ts`): since web 97b3bab students
 * publish their own draw points and whiteboard ops, and hand / draw-request
 * signals ride `cls-signal` instead of only a state nudge.
 */
import { STATE_TOPIC } from './web/pollPolicy';
import {
  CHAT_TOPIC,
  SIGNAL_TOPIC,
  decodeSignalPacket,
  drawPacketTrusted,
  senderKind,
  signalPacketTrusted,
} from './web/realtimePackets';

export type LiveAction =
  | { kind: 'state' }
  | { kind: 'chat' }
  /** Hand / draw request / draw permission: refresh the roster now. `allow` set for a server draw-allow. */
  | { kind: 'signal'; allow?: { identity: string; on: boolean } }
  | { kind: 'draw' }
  | { kind: 'ignore' };

export type LiveCtx = {
  drawTopic: string;
  /** LiveKit identities allowed to draw right now (from /state plus draw-allow pushes). */
  drawIdentities: ReadonlySet<string>;
};

function decodeJson(payload: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
}

export function routeLivePacket(topic: string | undefined, sender: string | null | undefined, payload: Uint8Array, ctx: LiveCtx): LiveAction {
  if (topic === STATE_TOPIC) return { kind: 'state' };
  if (topic === CHAT_TOPIC) return { kind: 'chat' };
  if (topic === SIGNAL_TOPIC) {
    const sig = decodeSignalPacket(decodeJson(payload));
    // Students hold no data grant: hand / draw-request pushes come from the
    // server (or a teacher tab) and only trigger a /state refresh (server truth).
    if (!sig) return { kind: 'ignore' };
    if (sig.type === 'draw-allow') {
      if (!signalPacketTrusted(sig, sender, null)) return { kind: 'ignore' };
      return { kind: 'signal', allow: { identity: sig.identity, on: sig.on } };
    }
    const k = senderKind(sender);
    if (k === 'server' || k === 'teacher') return { kind: 'signal' };
    return { kind: 'ignore' };
  }
  if (topic === ctx.drawTopic) {
    const raw = decodeJson(payload) as { t?: unknown; by?: unknown } | null;
    if (!raw || typeof raw.t !== 'string') return { kind: 'ignore' };
    const packet = { t: raw.t, by: typeof raw.by === 'string' ? raw.by : undefined };
    // Server relay only: it checked the draw permission and stamped `by`.
    if (!drawPacketTrusted({ senderIdentity: sender, packet })) return { kind: 'ignore' };
    if (senderKind(sender) === 'teacher') return { kind: 'ignore' }; // my own echo / another teacher tab
    return { kind: 'draw' };
  }
  return { kind: 'ignore' };
}

/** Holder identities from a snapshot, updated by draw-allow pushes that arrive before the next /state. */
export function drawIdentitySet(holders: { identity: string }[], pushes: Map<string, boolean>): Set<string> {
  const s = new Set(holders.map((h) => h.identity).filter(Boolean));
  for (const [id, on] of pushes) {
    if (on) s.add(id);
    else s.delete(id);
  }
  return s;
}

'use client';
/**
 * Whiteboard wiring for the web app (the board UI + model are shared with the
 * Windows teacher app in lib/whiteboard).
 *
 * - WhiteboardHost: web teacher. Owns the board; publishes ops over LiveKit
 *   data (topic `wb`, reliable); answers snapshot requests relayed by the
 *   server and sends a snapshot to every participant that connects.
 * - WhiteboardViewer: students (and admin preview/observer). Renders the
 *   teacher's board scaled to the viewport; asks for a snapshot on start and
 *   after every reconnect; students allowed to draw annotate through the
 *   server relay (same permission as drawing on the share).
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { ConnectionState, RoomEvent, type RemoteParticipant } from 'livekit-client';
import { MEETING_BAR_PX } from '@/lib/shareChrome';
import { WhiteboardBoard } from '@/lib/whiteboard/WhiteboardBoard';
import { SNAP_STORE_MS, WhiteboardSession, b64ToPackets, opsPackets, packetsToB64 } from '@/lib/whiteboard/session';
import { WB_TOPIC, cleanDoc, isOwnRelayEcho, studentOpAllowed, type Op, type Packet } from '@/lib/whiteboard/model';
import { roomFetch } from '@/lib/classroomClient';

export const wbStoreKey = (code: string) => `wb_doc_${code.toUpperCase()}`;
/** A board saved by this tab (reload / rejoin while the whiteboard was open). */
export function hasSavedBoard(code: string): boolean {
  try {
    return !!sessionStorage.getItem(wbStoreKey(code));
  } catch {
    return false;
  }
}

const isTeacherId = (id: string) => id.startsWith('teacher_') && !id.endsWith('__screen');

/** Ops relayed by the server for a student carry `by`; keep only what that student may do. */
export function filterRelayed(session: WhiteboardSession, p: Packet & { by?: string }): boolean {
  if (p.t !== 'ops' || !p.by) return true;
  p.ops = p.ops.filter((op) => studentOpAllowed(op, p.by!, session.doc));
  return p.ops.length > 0;
}

export function WhiteboardHost({
  code,
  identity,
  onClose,
  stopRef,
}: {
  code: string;
  identity: string;
  onClose: () => void;
  stopRef?: { current: (() => void) | null };
}) {
  const room = useRoomContext();
  const session = useMemo(() => {
    // Survive a reload / rejoin of the teacher tab (the board lives here).
    try {
      const raw = sessionStorage.getItem(wbStoreKey(code));
      const doc = raw ? cleanDoc(JSON.parse(raw)) : null;
      if (doc) return new WhiteboardSession(doc, true);
    } catch {
      /* ignore */
    }
    return new WhiteboardSession(undefined, true);
  }, [code]);
  useEffect(() => {
    let t: number | null = null;
    const off = session.subscribe(() => {
      if (t !== null) return;
      t = window.setTimeout(() => {
        t = null;
        try {
          sessionStorage.setItem(wbStoreKey(code), JSON.stringify(session.doc));
        } catch {
          /* quota (large images): keep going without persistence */
        }
      }, 1000);
    });
    return () => {
      off();
      if (t !== null) window.clearTimeout(t);
    };
  }, [session, code]);

  const publish = useCallback(
    async (packets: Uint8Array[], to?: string[]) => {
      // Students never publish board data; only the teacher host calls this.
      const pause = () => new Promise((resolve) => setTimeout(resolve, 200));
      for (const data of packets) {
        let sent = false;
        for (let attempt = 0; attempt < 8 && !sent; attempt++) {
          if (room.state !== ConnectionState.Connected) {
            await pause();
            continue;
          }
          try {
            await room.localParticipant.publishData(data as Uint8Array<ArrayBuffer>, {
              reliable: true,
              topic: WB_TOPIC,
              destinationIdentities: to,
            });
            sent = true;
          } catch (e) {
            // The first failure is usually mid-renegotiation. Retry quietly.
            if (attempt >= 7) console.warn('whiteboard publish', e);
            else await pause();
          }
        }
      }
    },
    [room]
  );
  const sendSnapshot = useCallback(async (to?: string[]) => publish(await session.snapshotPackets(), to), [publish, session]);

  // Keep the latest snapshot on the server too (Redis): a student whose request the
  // teacher's device cannot answer (teacher reconnecting, other web instance /
  // media node) still gets the board. At most once per SNAP_STORE_MS while it changes.
  useEffect(() => {
    let t: number | null = null;
    const store = async () => {
      t = null;
      const packets = packetsToB64(await session.snapshotPackets());
      void roomFetch(code, '/whiteboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'snap', packets }) }).catch(() => undefined);
    };
    const off = session.subscribe(() => {
      if (t === null) t = window.setTimeout(() => void store(), SNAP_STORE_MS);
    });
    t = window.setTimeout(() => void store(), 1500);
    return () => {
      off();
      if (t !== null) window.clearTimeout(t);
    };
  }, [session, code]);

  useEffect(() => {
    void roomFetch(code, '/whiteboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'on' }) });
    void sendSnapshot();
    const snapSoon = window.setTimeout(() => void sendSnapshot(), 500);
    const snapLater = window.setTimeout(() => void sendSnapshot(), 1500);
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _k?: unknown, topic?: string) => {
      if (topic !== WB_TOPIC || participant) return; // only server-relayed packets
      void (async () => {
        const text = new TextDecoder().decode(payload);
        let p: (Packet & { by?: string }) | null = null;
        try {
          p = JSON.parse(text);
        } catch {
          return;
        }
        if (!p) return;
        if (p.t === 'req') return void sendSnapshot([p.to]);
        if (p.t === 'ops' && !filterRelayed(session, p)) return;
        await session.receive(new TextEncoder().encode(JSON.stringify(p)));
      })();
    };
    const onJoin = (p: RemoteParticipant) => void sendSnapshot([p.identity]);
    const onReconnected = () => void sendSnapshot();
    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.ParticipantConnected, onJoin);
    room.on(RoomEvent.Reconnected, onReconnected);
    return () => {
      window.clearTimeout(snapSoon);
      window.clearTimeout(snapLater);
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.ParticipantConnected, onJoin);
      room.off(RoomEvent.Reconnected, onReconnected);
    };
  }, [room, code, session, sendSnapshot]);

  const stop = useCallback(() => {
    try {
      sessionStorage.removeItem(wbStoreKey(code));
    } catch {
      /* ignore */
    }
    void roomFetch(code, '/whiteboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'off' }) });
    onClose();
  }, [code, onClose]);

  if (stopRef) stopRef.current = stop;
  // Full-height board. The meeting bar owns the right 54px (Stop, End, mic).
  // The teacher footer is hidden while this is open.
  return (
    <div className="fixed bottom-0 left-0 top-0 z-40 flex bg-[#0b0f14]" style={{ right: MEETING_BAR_PX }} data-testid="wb-host">
      <div className="relative min-w-0 flex-1">
        <WhiteboardBoard session={session} mode="edit" identity={identity} onSend={(ops) => void publish(opsPackets(ops))} onClose={stop} hideStop />
      </div>
    </div>
  );
}

/**
 * Viewer. `requestSnapshot` asks for the board (student route or admin route).
 * `sendOps` (students allowed to draw) posts annotation ops to the relay.
 */
export function WhiteboardViewer({
  identity,
  canAnnotate,
  requestSnapshot,
  fetchStored,
  sendOps,
}: {
  identity: string;
  canAnnotate: boolean;
  requestSnapshot: () => void;
  /** Server-kept snapshot (base64 packets) when the teacher's device does not answer. */
  fetchStored?: () => Promise<unknown>;
  sendOps?: (ops: Op[]) => Promise<unknown>;
}) {
  const room = useRoomContext();
  const session = useMemo(() => new WhiteboardSession(), []);
  const reqRef = useRef(requestSnapshot);
  reqRef.current = requestSnapshot;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const storedRef = useRef(fetchStored);
  storedRef.current = fetchStored;

  useEffect(() => {
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _k?: unknown, topic?: string) => {
      if (topic !== WB_TOPIC) return;
      if (participant && !isTeacherId(participant.identity)) return;
      void (async () => {
        let p: (Packet & { by?: string }) | null = null;
        try {
          p = JSON.parse(new TextDecoder().decode(payload));
        } catch {
          return;
        }
        if (!p || p.t === 'req') return;
        if (isOwnRelayEcho(p, identityRef.current)) return; // my own stroke, already drawn locally
        if (p.t === 'ops' && !filterRelayed(session, p)) return;
        await session.receive(new TextEncoder().encode(JSON.stringify(p)));
      })();
    };
    room.on(RoomEvent.DataReceived, onData);
    const ask = () => reqRef.current();
    room.on(RoomEvent.Reconnected, ask);
    ask();
    // No snapshot yet (teacher reconnecting, lost packet): ask again a few times.
    let tries = 0;
    const iv = window.setInterval(() => {
      if (session.ready || ++tries > 6) return window.clearInterval(iv);
      ask();
      // The teacher's device did not answer: use the copy the server keeps.
      void storedRef.current?.().then(async (list) => {
        if (session.ready) return;
        for (const bytes of b64ToPackets(list)) await session.receive(bytes);
      });
    }, 5000);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.Reconnected, ask);
      window.clearInterval(iv);
    };
  }, [room, session]);

  // Students: coalesce ops, one request in flight (the 30 ms batches merge while waiting).
  const queue = useRef<Op[]>([]);
  const busy = useRef(false);
  const pump = useCallback(async () => {
    if (busy.current || !sendOps) return;
    busy.current = true;
    try {
      while (queue.current.length) {
        const ops = queue.current.splice(0, 20);
        await sendOps(ops).catch(() => undefined);
      }
    } finally {
      busy.current = false;
    }
  }, [sendOps]);

  return (
    <WhiteboardBoard
      session={session}
      mode={canAnnotate && sendOps ? 'annotate' : 'view'}
      identity={identity}
      onSend={(ops) => {
        queue.current.push(...ops);
        void pump();
      }}
      waitingLabel="Loading the whiteboard…"
    />
  );
}

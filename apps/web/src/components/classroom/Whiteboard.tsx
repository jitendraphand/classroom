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
import { RoomEvent, type RemoteParticipant } from 'livekit-client';
import { WhiteboardBoard } from '@/lib/whiteboard/WhiteboardBoard';
import { WhiteboardSession, opsPackets } from '@/lib/whiteboard/session';
import { WB_TOPIC, cleanDoc, studentOpAllowed, type Op, type Packet } from '@/lib/whiteboard/model';
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

export function WhiteboardHost({ code, identity, onClose }: { code: string; identity: string; onClose: () => void }) {
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
      for (const data of packets) {
        await room.localParticipant
          .publishData(data as Uint8Array<ArrayBuffer>, { reliable: true, topic: WB_TOPIC, destinationIdentities: to })
          .catch((e) => console.warn('whiteboard publish', e));
      }
    },
    [room]
  );
  const sendSnapshot = useCallback(async (to?: string[]) => publish(await session.snapshotPackets(), to), [publish, session]);

  useEffect(() => {
    void roomFetch(code, '/whiteboard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'on' }) });
    void sendSnapshot();
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

  return (
    <div className="fixed inset-0 z-[95]" data-testid="wb-host">
      <WhiteboardBoard session={session} mode="edit" identity={identity} onSend={(ops) => void publish(opsPackets(ops))} onClose={stop} />
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
  sendOps,
}: {
  identity: string;
  canAnnotate: boolean;
  requestSnapshot: () => void;
  sendOps?: (ops: Op[]) => Promise<unknown>;
}) {
  const room = useRoomContext();
  const session = useMemo(() => new WhiteboardSession(), []);
  const reqRef = useRef(requestSnapshot);
  reqRef.current = requestSnapshot;

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

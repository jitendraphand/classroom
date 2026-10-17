/**
 * Windows teacher whiteboard (item 5). Same model / wire format as the web app
 * (src/shared/web/whiteboard, synced from classroom apps/web/src/lib/whiteboard):
 * ops over LiveKit reliable data (topic `wb`), compressed snapshots for late
 * joiners and on request, student annotation relayed by the server (`by`) and
 * filtered by studentOpAllowed. The board UI runs in a window.open child
 * (whiteboard.html) in this same renderer process, so it shares the session object.
 */
import { RoomEvent, type RemoteParticipant, type Room } from 'livekit-client';
import { SNAP_STORE_MS, WhiteboardSession, opsPackets, packetsToB64 } from '../shared/web/whiteboard/session';
import type { PanelSnapshot, TeacherAction } from '../shared/actions';
import { WB_TOPIC, cleanDoc, studentOpAllowed, type Op, type Packet } from '../shared/web/whiteboard/model';

export const WB_STORE_KEY = 'classroom.whiteboardDoc';

/** What the whiteboard window's right-hand meeting bar needs from the class (same renderer process). */
export type WbMeeting = {
  snapshot: () => PanelSnapshot;
  subscribe: (cb: () => void) => () => void;
  send: (action: TeacherAction) => void;
  togglePanel: (kind: 'chat' | 'roster' | 'devices') => void;
};

type BoardApi = { mount: (session: WhiteboardSession, identity: string, onSend: (ops: Op[]) => void, onClose: () => void, meeting?: WbMeeting) => void };

/** Relayed student ops carry `by`: keep only what that student may do. */
export function filterRelayedOps(session: WhiteboardSession, p: Packet & { by?: string }): boolean {
  if (p.t !== 'ops' || !p.by) return true;
  p.ops = p.ops.filter((op) => studentOpAllowed(op, p.by!, session.doc));
  return p.ops.length > 0;
}

export function loadSavedBoard(storage: Pick<Storage, 'getItem'> | null): WhiteboardSession {
  try {
    const raw = storage?.getItem(WB_STORE_KEY);
    const doc = raw ? cleanDoc(JSON.parse(raw)) : null;
    if (doc) return new WhiteboardSession(doc, true);
  } catch {
    /* ignore */
  }
  return new WhiteboardSession(undefined, true);
}

export class WindowsWhiteboard {
  readonly session: WhiteboardSession;
  private win: Window | null = null;
  private offs: (() => void)[] = [];
  private saveTimer: number | null = null;

  constructor(
    private room: Room,
    private identity: string,
    private api: (method: string, suffix: string, body?: unknown) => Promise<unknown>,
    private onClosed: () => void,
    private meeting?: WbMeeting
  ) {
    this.session = loadSavedBoard(localStorage);
  }

  get open(): boolean {
    return !!this.win && !this.win.closed;
  }

  async start(): Promise<void> {
    void this.api('POST', '/whiteboard', { action: 'on' });
    const room = this.room;
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _k?: unknown, topic?: string) => {
      if (topic !== WB_TOPIC || participant) return; // only server-relayed packets
      let p: (Packet & { by?: string }) | null = null;
      try {
        p = JSON.parse(new TextDecoder().decode(payload));
      } catch {
        return;
      }
      if (!p) return;
      if (p.t === 'req') return void this.sendSnapshot([(p as { to: string }).to]);
      if (p.t === 'ops' && !filterRelayedOps(this.session, p)) return;
      void this.session.receive(new TextEncoder().encode(JSON.stringify(p)));
    };
    const onJoin = (p: RemoteParticipant) => void this.sendSnapshot([p.identity]);
    const onReconnected = () => void this.sendSnapshot();
    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.ParticipantConnected, onJoin);
    room.on(RoomEvent.Reconnected, onReconnected);
    this.offs.push(() => {
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.ParticipantConnected, onJoin);
      room.off(RoomEvent.Reconnected, onReconnected);
    });
    this.offs.push(
      this.session.subscribe(() => {
        if (this.saveTimer !== null) return;
        this.saveTimer = window.setTimeout(() => {
          this.saveTimer = null;
          try {
            localStorage.setItem(WB_STORE_KEY, JSON.stringify(this.session.doc));
          } catch {
            /* quota */
          }
        }, 3000); // full-doc JSON: at most every 3 s while drawing (round 6 CPU)
      })
    );
    // Server copy of the board (Redis) for students whose request this device cannot answer.
    let snapTimer: number | null = null;
    const storeSnap = async () => {
      snapTimer = null;
      void this.api('POST', '/whiteboard', { action: 'snap', packets: packetsToB64(await this.session.snapshotPackets()) });
    };
    this.offs.push(
      this.session.subscribe(() => {
        if (snapTimer === null) snapTimer = window.setTimeout(() => void storeSnap(), SNAP_STORE_MS);
      })
    );
    this.offs.push(() => {
      if (snapTimer !== null) window.clearTimeout(snapTimer);
    });
    snapTimer = window.setTimeout(() => void storeSnap(), 1500);
    void this.sendSnapshot();
    await this.openWindow();
  }

  private async openWindow(): Promise<void> {
    this.win = window.open('app://classroom/whiteboard.html', 'classroom-whiteboard', 'width=1280,height=760');
    if (!this.win) return;
    for (let i = 0; i < 100; i++) {
      const api = (this.win as unknown as { __board?: BoardApi } | null)?.__board;
      if (api) {
        api.mount(this.session, this.identity, (ops) => void this.publish(opsPackets(ops)), () => this.stop(), this.meeting);
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const w = this.win;
    const iv = window.setInterval(() => {
      if (w.closed) {
        window.clearInterval(iv);
        if (this.win === w) this.stop();
      }
    }, 500);
    this.offs.push(() => window.clearInterval(iv));
  }

  focus(): void {
    this.win?.focus();
  }

  private async publish(packets: Uint8Array[], to?: string[]): Promise<void> {
    for (const data of packets) {
      await this.room.localParticipant.publishData(data as Uint8Array<ArrayBuffer>, { reliable: true, topic: WB_TOPIC, destinationIdentities: to }).catch((e) => console.warn('whiteboard publish', e));
    }
  }

  private async sendSnapshot(to?: string[]): Promise<void> {
    await this.publish(await this.session.snapshotPackets(), to);
  }

  /** Close the board for everyone (teacher pressed close or left). */
  stop(clearSaved = true): void {
    const offs = this.offs;
    this.offs = [];
    offs.forEach((f) => f());
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    if (clearSaved) {
      try {
        localStorage.removeItem(WB_STORE_KEY);
      } catch {
        /* ignore */
      }
    }
    void this.api('POST', '/whiteboard', { action: 'off' });
    const w = this.win;
    this.win = null;
    if (w && !w.closed) w.close();
    this.onClosed();
  }
}

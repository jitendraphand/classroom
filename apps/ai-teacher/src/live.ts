/**
 * The AI teacher in a live class: joins the LiveKit room as the teacher's
 * own connection (so the class sees its teacher present and students' mics
 * follow the usual rules), hosts the whiteboard, publishes the teacher's
 * voice, and turns room events into System 1 input.
 *
 * It subscribes to nothing by default (a class of hundreds costs it no
 * bandwidth); a student's microphone is subscribed only while the AI has
 * given that student the floor and speech-to-text is configured.
 */
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
} from '@livekit/rtc-node';
import { ClassroomApi, type ChatMessage, type RoomState } from './api';
import { Audit } from './audit';
import { BoardHost } from './board';
import { Reflex, type Policy, SpeechChunker } from './reflex';
import { Utterances, resample, type Stt, type Tts } from './speech';

const WB_TOPIC = 'wb';
const CHAT_TOPIC = 'chat';
const SIGNAL_TOPIC = 'cls-signal';
const STATE_TOPIC = 'cls-state';
const OUT_RATE = 48000;

export type LiveOptions = { policy: Policy; tts: Tts | null; stt: Stt | null; audit: Audit };

export type SpeechEvent = { from: string; name: string; text: string; at: number };

export class LiveClass {
  readonly reflex: Reflex;
  readonly board: BoardHost;
  room: Room | null = null;
  state: RoomState | null = null;
  identity = '';
  private source: AudioSource | null = null;
  private speaking: AbortController | null = null;
  private chatCursor: string | undefined;
  private seen = new Set<string>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private waiters: (() => void)[] = [];
  private floor = new Map<string, AbortController>();
  readonly speech: SpeechEvent[] = [];
  /** Supervisor commands not yet reported to the reasoning layer. */
  readonly supervisor: { command: string; at: number }[] = [];
  ended = false;

  constructor(
    readonly api: ClassroomApi,
    readonly code: string,
    private readonly opts: LiveOptions
  ) {
    this.reflex = new Reflex(opts.policy);
    this.board = new BoardHost(
      {
        publish: async (packets, to) => {
          const lp = this.room?.localParticipant;
          if (!lp) return;
          for (const p of packets) await lp.publishData(p, { reliable: true, topic: WB_TOPIC, ...(to?.length ? { destination_identities: to } : {}) });
        },
        storeSnapshot: async (packets) => {
          await this.api.whiteboard(this.code, { action: 'snap', packets });
        },
      },
      'teacher'
    );
  }

  /** Connect as the teacher and start listening. */
  async join(): Promise<void> {
    const info = await this.api.token(this.code);
    this.identity = info.identity;
    this.board.by = info.identity;
    const room = new Room();
    room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => this.onData(payload, participant, topic));
    room.on(RoomEvent.ParticipantConnected, (p) => {
      if (this.board.open) void this.board.sendSnapshot([p.identity]);
      this.scheduleRefresh();
    });
    room.on(RoomEvent.ParticipantDisconnected, () => this.scheduleRefresh());
    room.on(RoomEvent.Reconnected, () => {
      if (this.board.open) void this.board.sendSnapshot();
      this.scheduleRefresh();
    });
    room.on(RoomEvent.Disconnected, () => this.wake());
    await room.connect(info.url, info.token, { autoSubscribe: false, dynacast: true });
    this.room = room;

    // The teacher's voice: one microphone track for the whole class.
    this.source = new AudioSource(OUT_RATE, 1);
    const track = LocalAudioTrack.createAudioTrack('ai-teacher-voice', this.source);
    await room.localParticipant!.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE, dtx: true, red: true }));

    await this.refresh();
    this.timers.push(setInterval(() => void this.pollChat(), 4000));
    this.timers.push(setInterval(() => void this.refresh(), 15_000));
    this.timers.push(setInterval(() => void this.api.renew().catch(() => undefined), 30 * 60_000));
    this.opts.audit.write({ event: 'joined', code: this.code, identity: this.identity });
  }

  async leave(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.stopSpeaking();
    for (const c of this.floor.values()) c.abort();
    this.floor.clear();
    await this.room?.disconnect().catch(() => undefined);
    this.room = null;
    this.wake();
  }

  // ------------------------------------------------------------ events in

  private onData(payload: Uint8Array, participant: RemoteParticipant | undefined, topic: string | undefined): void {
    // Students have no data grant: everything that matters comes from the
    // server (no participant). Ignore anything else.
    if (participant) return;
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
    } catch {
      return;
    }
    const now = Date.now();
    if (topic === WB_TOPIC) {
      if (p.t === 'req' && typeof p.to === 'string' && this.board.open) void this.board.sendSnapshot([p.to]);
      else if (p.t === 'ops') void this.board.session.receive(payload);
      return;
    }
    if (topic === CHAT_TOPIC && p.type === 'message' && p.message) {
      this.onMessage(p.message as ChatMessage, now);
      return;
    }
    if (topic === SIGNAL_TOPIC && p.type === 'hand' && typeof p.participantId === 'string') {
      const who = this.state?.admitted.find((a) => a.id === p.participantId);
      this.reflex.onHand(p.participantId, who?.displayName ?? 'A student', p.raised === true, now);
      this.wake();
      return;
    }
    if (topic === STATE_TOPIC) this.scheduleRefresh();
  }

  /** A human supervisor paused the AI (control endpoint, or a teacher "/ai pause" chat message). */
  paused = false;

  /** Supervisor command: pause (acting tools refuse, speech stops), resume, or stop (wrap up now). */
  supervise(command: 'pause' | 'resume' | 'stop', via: string): void {
    this.paused = command === 'pause';
    if (command !== 'resume') this.stopSpeaking();
    this.supervisor.push({ command, at: Date.now() });
    this.opts.audit.write({ event: 'supervisor', command, via });
    this.wake();
  }

  private onMessage(m: ChatMessage, now: number): void {
    if (this.seen.has(m.id)) return;
    this.seen.add(m.id);
    if (!this.chatCursor || m.createdAt > this.chatCursor) this.chatCursor = m.createdAt;
    if (m.senderRole === 'TEACHER') {
      const cmd = /^\/ai\s+(pause|resume|stop)\b/i.exec(m.body.trim())?.[1]?.toLowerCase();
      if (cmd) this.supervise(cmd as 'pause' | 'resume' | 'stop', 'chat');
      return;
    }
    if (m.senderRole !== 'STUDENT') return;
    const kind = this.reflex.onChat(
      { id: m.id, from: m.senderParticipantId, fromName: m.senderName, role: m.senderRole, text: m.body, private: m.scope !== 'BROADCAST', at: now },
      now
    );
    if (kind === 'unsafe') this.opts.audit.write({ event: 'escalation', from: m.senderParticipantId, name: m.senderName, text: m.body });
    if (kind !== 'spam' && kind !== 'greeting' && kind !== 'answer') this.wake();
  }

  private async pollChat(): Promise<void> {
    try {
      const r = await this.api.messages(this.code, this.chatCursor);
      if (r.ended) this.ended = true;
      for (const m of r.messages) this.onMessage(m, Date.now());
    } catch {
      /* next poll */
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 500);
  }

  /** Re-read the class state: roster, waiting list (admission policy), hands. */
  async refresh(): Promise<RoomState | null> {
    let st: RoomState;
    try {
      st = await this.api.state(this.code);
    } catch (e) {
      if (e instanceof Error && /ended/i.test(e.message)) this.ended = true;
      return this.state;
    }
    // An ended or unavailable class answers without the lists.
    if (!Array.isArray(st.admitted)) {
      if (st.status === 'ENDED' || (st as { ended?: boolean }).ended) this.ended = true;
      return this.state;
    }
    st.raisedHands = Array.isArray(st.raisedHands) ? st.raisedHands : [];
    st.waiting = Array.isArray(st.waiting) ? st.waiting : [];
    const before = new Set(this.state?.admitted.map((a) => a.id) ?? []);
    const now = Date.now();
    for (const a of st.admitted) if (a.role === 'STUDENT' && !before.has(a.id) && this.state) this.reflex.onJoin(a.displayName);
    const nowIds = new Set(st.admitted.map((a) => a.id));
    for (const a of this.state?.admitted ?? []) if (a.role === 'STUDENT' && !nowIds.has(a.id)) this.reflex.onLeave(a.id, a.displayName);
    for (const id of st.raisedHands) {
      const who = st.admitted.find((a) => a.id === id);
      this.reflex.onHand(id, who?.displayName ?? 'A student', true, now);
    }
    this.state = st;
    if (st.status === 'ENDED') this.ended = true;
    const admit = this.reflex.onWaiting(st.waiting.map((w) => ({ id: w.id, name: w.displayName, signed: !!w.sid })));
    if (admit.length) {
      await this.api.admit(this.code, { ids: admit }).catch(() => undefined);
      this.opts.audit.write({ event: 'auto-admit', policy: this.opts.policy.admit, count: admit.length });
    }
    if (this.reflex.pending()) this.wake();
    return st;
  }

  /** Resolves when System 1 has something new, the class ended, or after `ms`. */
  waitForEvents(ms: number): Promise<void> {
    if (this.reflex.pending() || this.ended || this.supervisor.length) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.waiters.push(done);
    });
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  // ------------------------------------------------------------ voice out

  get canSpeak(): boolean {
    return !!this.opts.tts && !!this.source;
  }

  /** Stop talking now (a student started speaking, or the AI changed its mind). */
  stopSpeaking(): void {
    this.speaking?.abort();
    this.speaking = null;
    this.speakChain = Promise.resolve();
    this.source?.clearQueue();
  }

  private speakChain: Promise<void> = Promise.resolve();

  /**
   * Queue one sentence after whatever is already queued (speech streamed
   * while the model is still writing it). Synthesis starts at once, so the
   * next sentence is ready when the current one finishes playing.
   */
  queueSpeech(text: string): void {
    const tts = this.opts.tts;
    if (!tts || !this.source || !text.trim()) return;
    if (!this.speaking) this.speaking = new AbortController();
    const ctl = this.speaking;
    const pcm = tts.synth(text, ctl.signal).catch(() => null);
    this.speakChain = this.speakChain.then(async () => {
      const samples = await pcm;
      if (!samples || ctl.signal.aborted) return;
      await this.play(resample(samples, tts.sampleRate, OUT_RATE), ctl.signal);
    });
  }

  /**
   * Say `text` aloud as the teacher. Sentences are synthesised one by one and
   * the first is playing while the next is synthesised. Resolves when queued
   * (not when played); `waitDone` waits for playout too.
   */
  async speak(text: string, waitDone = false): Promise<{ sentences: number; seconds: number }> {
    if (!this.opts.tts || !this.source) throw new Error('No text-to-speech is configured (AI_TEACHER_TTS_URL).');
    this.stopSpeaking();
    const ctl = new AbortController();
    this.speaking = ctl;
    const chunker = new SpeechChunker();
    const parts = [...chunker.push(text), ...chunker.flush()];
    let seconds = 0;
    for (const part of parts) {
      if (ctl.signal.aborted) break;
      const pcm = await this.opts.tts.synth(part, ctl.signal);
      if (ctl.signal.aborted) break;
      seconds += await this.play(resample(pcm, this.opts.tts.sampleRate, OUT_RATE), ctl.signal);
    }
    if (waitDone && !ctl.signal.aborted) await this.source.waitForPlayout();
    return { sentences: parts.length, seconds: Math.round(seconds * 10) / 10 };
  }

  /** Queue 48 kHz mono PCM on the teacher's track in 10 ms frames. */
  async play(pcm: Int16Array, signal?: AbortSignal): Promise<number> {
    if (!this.source) throw new Error('Not connected');
    const n = OUT_RATE / 100;
    for (let i = 0; i < pcm.length; i += n) {
      if (signal?.aborted) break;
      const frame = new Int16Array(n);
      frame.set(pcm.subarray(i, Math.min(pcm.length, i + n)));
      await this.source.captureFrame(new AudioFrame(frame, OUT_RATE, 1, n));
    }
    return pcm.length / OUT_RATE;
  }

  // ------------------------------------------------------------ the floor

  /** Unmute one student to speak (and listen to them when speech-to-text is configured). */
  async giveFloor(participantId: string): Promise<void> {
    await this.api.muteOne(this.code, participantId, false);
    await this.api.lowerHand(this.code, participantId).catch(() => undefined);
    this.reflex.onSpoke(participantId, Date.now());
    if (this.opts.stt) this.listen(participantId);
  }

  async takeFloor(participantId: string): Promise<void> {
    this.floor.get(participantId)?.abort();
    this.floor.delete(participantId);
    await this.api.muteOne(this.code, participantId, true);
  }

  private listen(participantId: string): void {
    const who = this.state?.admitted.find((a) => a.id === participantId);
    const remote = who && this.room?.remoteParticipants.get(who.livekitIdentity);
    if (!who || !remote || this.floor.has(participantId)) return;
    const ctl = new AbortController();
    this.floor.set(participantId, ctl);
    const attach = (track: RemoteTrack) => {
      if (track.kind !== TrackKind.KIND_AUDIO || ctl.signal.aborted) return;
      void this.transcribeFrom(track, who.id, who.displayName, ctl.signal);
    };
    for (const pub of remote.trackPublications.values()) {
      if (pub.source === TrackSource.SOURCE_MICROPHONE) {
        pub.setSubscribed(true);
        if (pub.track) attach(pub.track as RemoteTrack);
      }
    }
    const onSub = (track: RemoteTrack, _pub: unknown, p: RemoteParticipant) => {
      if (p.identity === who.livekitIdentity) attach(track);
    };
    this.room!.on(RoomEvent.TrackSubscribed, onSub);
    ctl.signal.addEventListener('abort', () => {
      this.room?.off(RoomEvent.TrackSubscribed, onSub);
      for (const pub of remote.trackPublications.values()) if (pub.source === TrackSource.SOURCE_MICROPHONE) pub.setSubscribed(false);
    });
  }

  private async transcribeFrom(track: RemoteTrack, id: string, name: string, signal: AbortSignal): Promise<void> {
    const rate = 16000;
    const vad = new Utterances(rate);
    const stream = new AudioStream(track, rate, 1);
    const reader = stream.getReader();
    signal.addEventListener('abort', () => void reader.cancel().catch(() => undefined));
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || signal.aborted) break;
        const utt = vad.push(value.data);
        // Barge-in: the student started talking, so the AI stops.
        if (vad.active && this.speaking) this.stopSpeaking();
        if (utt && this.opts.stt) {
          const text = await this.opts.stt.transcribe(utt, rate, signal).catch(() => '');
          if (text) {
            this.speech.push({ from: id, name, text, at: Date.now() });
            this.reflex.onChat({ id: `speech-${Date.now()}`, from: id, fromName: name, role: 'STUDENT', text, private: false, at: Date.now() }, Date.now());
            this.wake();
          }
        }
      }
    } catch {
      /* stream closed */
    }
  }
}

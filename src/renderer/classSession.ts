/**
 * Teacher class: the same server calls and LiveKit publish options as the
 * website. Screen video is Windows.Graphics.Capture only, so excluded classroom
 * windows are left out of the picture instead of painted black.
 * The session cookie and the LiveKit token stay out of logs.
 */

import {
  AudioPresets,
  ConnectionState,
  DisconnectReason,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  Track,
  VideoPreset,
  createLocalAudioTrack,
  type Participant,
  type RemoteTrack,
} from 'livekit-client';
import type { ChromeBounds, DeviceInfo, PanelSnapshot } from '../shared/actions';
import {
  ANNOTATE_TOPIC,
  applyAnnotateOp,
  fitSnapshot,
  packetTooBig,
  type AnnotateMsg,
  type AnnotateStroke,
} from '../shared/annotate';
import {
  chatPollMs,
  mergeMessages,
  parseRoomState,
  statePollMs,
  unreadCount,
  type AdmittedPerson,
  type ChatMessage,
  type RoomSnapshot,
} from '../shared/apiModel';
import { resolveChatRecipient } from '../shared/chatReply';
import { SCREEN_SHARE, TEACHER_CAMERA, dockGridStyle, screenShareSimulcastFor, shareAllowed, type CapturePlan, type ShareKind } from '../shared/capture';
import type { VideoCell, VideoModel } from '../shared/videoModel';
import { openWgcTrack, type WgcHandle } from './wgcTrack';
import {
  liveStudentPool,
  orderedPins,
  selectStudentTiles,
  sortRoster,
  studentCapForLayout,
  tileCells,
  videoGrid,
  type SlotCount,
} from '../shared/classLogic';
import { ShareMirror } from './videoMirror';
import { attentionEvents, countFocusAlerts, decideHandoff, endedSessionCopy, isEndedReason } from '../shared/session';
import { oldestWaiting } from '../shared/waiting';
import { desktop } from './bridge';
import { cropTrack, type CropHandle } from './cropTrack';

type TrackLike = {
  attach: (el: HTMLMediaElement) => HTMLMediaElement;
  detach: (el?: HTMLMediaElement) => HTMLMediaElement[];
};

type AnnotateHandle = {
  load: (strokes: AnnotateStroke[], from: string) => void;
  setPreview: (stream: MediaStream | null) => void;
};

export type ClassView = {
  phase: 'connecting' | 'live' | 'handoff' | 'ended';
  handoff: { kind: 'device' | 'session'; title: string; body: string } | null;
  notice: string;
  code: string;
  label: string;
  connection: string;
  micOn: boolean;
  camOn: boolean;
  sharing: boolean;
  shareKind: ShareKind | null;
  captureMode: CapturePlan['mode'];
  captureLabel: string;
  captureDetail: string;
  waitingRoomOn: boolean;
  layout: SlotCount;
  waiting: RoomSnapshot['waiting'];
  roster: AdmittedPerson[];
  messages: ChatMessage[];
  chatTo: string;
  meId: string | null;
  unread: number;
  annotateOn: boolean;
  videosOn: boolean;
  devices: DeviceInfo[];
  micId: string;
  camId: string;
  audioBlocked: boolean;
};

type ShareRequest = {
  kind: ShareKind;
  source: { id: string; displayId: string; name: string; kind: 'screen' | 'window' };
  display: { x: number; y: number; w: number; h: number } | null;
  region: { x: number; y: number; w: number; h: number } | null;
  systemAudio?: boolean;
};

type VideosApi = {
  setModel: (model: VideoModel) => void;
  whenPainted: (cb: () => void) => void;
};

type Host = {
  onView: (view: ClassView) => void;
  onLeft: () => void;
  onLogin: (message: string) => void;
};

const HIDDEN = /^(adminobserver_|adminpreview_)/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(data: unknown, fallback: string): string {
  if (data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string') {
    return (data as { error: string }).error;
  }
  return fallback;
}

function isHidden(identity: string): boolean {
  return HIDDEN.test(identity);
}

export class ClassController {
  private room: Room | null = null;
  private code = '';
  private gen = 0;
  private snap: RoomSnapshot | null = null;
  private messages: ChatMessage[] = [];
  private chatTo = 'all';
  private lastRead: string | null = null;
  private notice = '';
  private micOn = false;
  private camOn = false;
  private sharing = false;
  /** Student videos open with a share, and stay closed after the teacher dismisses them. */
  private showStudentVideos = false;
  private shareKind: ShareKind | null = null;
  private annotateOn = false;
  private connecting = false;
  private ended = false;
  private expectDisconnect = false;
  private handoff: ClassView['handoff'] = null;
  private pushLive = false;
  private clearedStaleStage = false;
  private audioBlocked = false;
  private devices: DeviceInfo[] = [];
  private micTrack: LocalAudioTrack | null = null;
  private camTrack: LocalVideoTrack | null = null;
  private screenTrack: LocalVideoTrack | null = null;
  private shareRaw: MediaStreamTrack | null = null;
  private screenAudio: LocalAudioTrack | null = null;
  private pendingAudio: Promise<MediaStream | null> | null = null;
  private shareCrop: CropHandle | null = null;
  private previewTrack: MediaStreamTrack | null = null;
  private overlayRect: { x: number; y: number; w: number; h: number } | null = null;
  private shareEpoch = 0;
  private chain: Promise<void> = Promise.resolve();
  private mosaic: string[] = [];
  private lastTick = 0;
  private rotationTick = 0;
  private rotationTimer = 0;
  private cameraTimer = 0;
  private readonly mirror = new ShareMirror(
    (key, jpeg) => desktop().postVideoTile(key, jpeg),
    (key) => this.mediaStreamFor(key)
  );
  private speakingId: string | null = null;
  private sticky = new Set<string>();
  private pinTimes = new Map<string, number>();
  private strokes: AnnotateStroke[] = [];
  private annotateTimer = 0;
  private dockHost: HTMLElement | null = null;
  private videosWin: Window | null = null;
  private videosGrid: HTMLElement | null = null;
  private annotateWin: Window | null = null;
  private wgcHandle: WgcHandle | null = null;
  private shareDisplayId = '';
  private bounds: ChromeBounds | null = null;
  private attached = new Map<string, { track: TrackLike; el: HTMLVideoElement }>();
  private lastCells: { key: string; label: string }[] = [];
  private attentionReady = false;
  private prevWaiting: RoomSnapshot['waiting'] = [];
  private prevStudents: AdmittedPerson[] = [];
  private prevMessages: ChatMessage[] = [];
  private regionWait: ((rect: { x: number; y: number; w: number; h: number } | null) => void) | null = null;
  private readonly onMessage: (ev: MessageEvent) => void;
  private unsubBounds: (() => void) | null = null;
  private unsubWgcEnded: (() => void) | null = null;

  constructor(
    private readonly opts: { layout: SlotCount; micId: string; camId: string; plan: CapturePlan },
    private readonly host: Host
  ) {
    this.onMessage = (ev: MessageEvent) => {
      if (ev.origin !== location.origin || !ev.data || typeof ev.data !== 'object') return;
      const data = ev.data as { channel?: string; msg?: AnnotateMsg; rect?: { x: number; y: number; w: number; h: number } };
      if (data.channel === 'annotate-out' && data.msg) void this.onAnnotate(data.msg);
      if (data.channel === 'region-picked') this.regionWait?.(data.rect ?? null);
      if (data.channel === 'region-cancel') this.regionWait?.(null);
    };
    window.addEventListener('message', this.onMessage);
    this.unsubBounds = desktop().onChromeBounds((bounds) => {
      this.bounds = bounds;
    });
    this.unsubWgcEnded = desktop().onWgcEnded(() => {
      if (this.sharing && this.wgcHandle) void this.stopShare();
    });
  }

  setDockHost(el: HTMLElement | null): void {
    this.dockHost = el;
    this.paintTiles();
  }

  view(): ClassView {
    const students = sortRoster((this.snap?.admitted ?? []).filter((p) => p.role === 'STUDENT'));
    let phase: ClassView['phase'] = 'live';
    if (this.ended) phase = 'ended';
    else if (this.handoff) phase = 'handoff';
    else if (this.connecting) phase = 'connecting';
    return {
      phase,
      handoff: this.handoff,
      notice: this.notice,
      code: this.code,
      label: this.snap?.classLabel || 'Class',
      connection: this.room ? this.room.state : ConnectionState.Disconnected,
      micOn: this.micOn,
      camOn: this.camOn,
      sharing: this.sharing,
      shareKind: this.shareKind,
      captureMode: this.opts.plan.mode,
      captureLabel: this.opts.plan.label,
      captureDetail: this.opts.plan.detail,
      waitingRoomOn: this.snap ? this.snap.waitingRoomOn : true,
      layout: this.opts.layout,
      waiting: this.snap?.waiting ?? [],
      roster: students,
      messages: this.messages,
      chatTo: this.chatTo,
      meId: this.snap?.meId ?? null,
      unread: unreadCount(this.messages, this.lastRead, this.snap?.meId ?? null),
      annotateOn: this.annotateOn,
      videosOn: this.videosOpen(),
      devices: this.devices,
      micId: this.opts.micId,
      camId: this.opts.camId,
      audioBlocked: this.audioBlocked,
    };
  }

  async start(code: string): Promise<void> {
    await this.stopRoom();
    this.code = code.toUpperCase();
    this.ended = false;
    this.handoff = null;
    this.expectDisconnect = false;
    this.connecting = true;
    this.notice = '';
    this.clearedStaleStage = false;
    this.attentionReady = false;
    this.messages = [];
    this.snap = null;
    this.gen += 1;
    const gen = this.gen;
    this.emit();
    desktop().setClassActive(true);
    const tokenRes = await desktop().api('GET', `/api/rooms/${encodeURIComponent(this.code)}/token`);
    if (this.gen !== gen) return;
    if (tokenRes.status === 401) {
      const reason = tokenRes.data && typeof tokenRes.data === 'object' && 'reason' in tokenRes.data ? String((tokenRes.data as { reason: unknown }).reason) : null;
      await this.enterHandoff('session', reason);
      return;
    }
    const body = (tokenRes.data ?? {}) as { token?: unknown; url?: unknown; error?: unknown };
    if (tokenRes.status !== 200 || typeof body.token !== 'string' || typeof body.url !== 'string') {
      this.connecting = false;
      this.notice = errorText(tokenRes.data, 'Could not join the class.');
      this.emit();
      return;
    }
    const room = new Room({
      disconnectOnPageLeave: false,
      adaptiveStream: { pauseVideoInBackground: false },
      dynacast: true,
      publishDefaults: {
        simulcast: false,
        backupCodec: false,
        dtx: true,
        red: true,
        audioPreset: AudioPresets.speech,
        videoEncoding: { maxBitrate: 200_000, maxFramerate: 15 },
        screenShareEncoding: { maxBitrate: SCREEN_SHARE.encoding.maxBitrate, maxFramerate: SCREEN_SHARE.encoding.maxFramerate },
      },
    });
    this.room = room;
    this.bindRoom(room);
    try {
      await room.connect(body.url, body.token, { autoSubscribe: true, peerConnectionTimeout: 20_000 });
      await room.startAudio().catch(() => undefined);
    } catch (err) {
      console.warn('connect failed');
      this.connecting = false;
      this.notice = 'Could not connect to the class.';
      this.emit();
      return;
    }
    if (this.gen !== gen) return;
    this.connecting = false;
    this.audioBlocked = room.canPlaybackAudio === false;
    this.micOn = true;
    await this.enqueue(() => this.syncMic());
    await this.refreshDevices();
    await this.roomApi('PATCH', '/settings', { maxVisibleVideos: studentCapForLayout(this.opts.layout) });
    // Marks are drawn on the overlay, which the monitor capture already includes.
    // Keeping this list empty means a snapshot does not paint them a second time
    // as SVG on the student page.
    this.strokes = [];
    this.rotationTimer = window.setInterval(() => {
      this.rotationTick += 1;
      this.ensureStudentCameras();
      this.emit();
    }, 8000);
    this.cameraTimer = window.setInterval(() => this.ensureStudentCameras(), 3000);
    this.ensureStudentCameras();
    void this.loops(gen);
    this.emit();
  }

  async takeBack(): Promise<void> {
    const kind = this.handoff?.kind ?? 'device';
    const res = await desktop().api('GET', '/api/auth/status');
    const data = (res.data ?? {}) as { role?: unknown; reason?: unknown };
    const decision = decideHandoff({
      kind,
      role: typeof data.role === 'string' ? data.role : null,
      reason: typeof data.reason === 'string' ? data.reason : null,
    });
    if (decision === 'login') {
      const copy = isEndedReason(data.reason) ? endedSessionCopy(data.reason) : endedSessionCopy('signed_in_elsewhere');
      this.host.onLogin(kind === 'session' && this.handoff ? this.handoff.body : copy.body);
      return;
    }
    const code = this.code;
    this.handoff = null;
    await this.start(code);
  }

  async hear(): Promise<void> {
    try {
      await this.room?.startAudio();
    } catch {
      /* ignore */
    }
    this.audioBlocked = this.room ? this.room.canPlaybackAudio === false : false;
    this.emit();
  }

  handle(action: { type: string; [key: string]: unknown }): void {
    switch (action.type) {
      case 'toggle-mic':
        this.micOn = !this.micOn;
        void this.enqueue(async () => {
          if (this.micOn) await this.syncMic();
          else await this.dropMic();
          this.emit();
        });
        this.emit();
        return;
      case 'toggle-cam':
        this.camOn = !this.camOn;
        void this.enqueue(async () => {
          if (this.camOn) await this.syncCam();
          else await this.dropCam();
          this.emit();
        });
        this.emit();
        return;
      case 'set-mic':
        this.opts.micId = typeof action.deviceId === 'string' ? action.deviceId : '';
        void desktop().saveDevices(this.opts.micId, this.opts.camId);
        if (this.micOn) {
          void this.enqueue(async () => {
            await this.dropMic();
            await this.syncMic();
          });
        }
        this.emit();
        return;
      case 'set-cam':
        this.opts.camId = typeof action.deviceId === 'string' ? action.deviceId : '';
        void desktop().saveDevices(this.opts.micId, this.opts.camId);
        if (this.camOn) {
          void this.enqueue(async () => {
            await this.dropCam();
            await this.syncCam();
          });
        }
        this.emit();
        return;
      case 'stop-share':
        void this.stopShare();
        return;
      case 'toggle-annotate':
        void this.toggleAnnotate();
        return;
      case 'toggle-videos':
        void this.toggleVideos();
        return;
      case 'layout':
        if (action.slots === 2 || action.slots === 4 || action.slots === 6) {
          this.opts.layout = action.slots;
          void desktop().saveLayout(action.slots);
          void this.roomApi('PATCH', '/settings', { maxVisibleVideos: studentCapForLayout(action.slots) });
          this.emit();
        }
        return;
      case 'waiting-room':
        void this.roomApi('PATCH', '/settings', { waitingRoomOn: action.on === true }).then(() => {
          this.notice = action.on ? 'Waiting room on: you admit each student.' : 'Waiting room off: students enter directly (muted).';
          void this.pollState();
        });
        return;
      case 'mute-all':
        void this.roomApi('POST', '/mute', { all: true, muted: action.muted === true }).then((res) => {
          this.notice = res && res.status < 400 ? (action.muted ? 'Students muted' : 'Students may unmute') : errorText(res?.data, 'Could not change mute.');
          void this.pollState();
        });
        return;
      case 'mute-one':
        if (typeof action.id === 'string') {
          void this.roomApi('POST', '/mute', { participantId: action.id, muted: action.muted === true }).then(() => this.pollState());
        }
        return;
      case 'pin':
        if (typeof action.id !== 'string') return;
        void this.roomApi('POST', '/pin-student', { participantId: action.id, pinned: action.pinned === true }).then((res) => {
          if (res?.status === 409) this.notice = errorText(res.data, 'All video slots are pinned. Unpin a student or show more videos first.');
          void this.pollState();
        });
        return;
      case 'lower-hand':
        if (typeof action.id === 'string') void this.roomApi('POST', '/hand', { participantId: action.id, raised: false }).then(() => this.pollState());
        return;
      case 'admit':
        if (typeof action.id === 'string') void this.roomApi('POST', '/admit', { participantIds: [action.id] }).then(() => this.pollState());
        return;
      case 'admit-all':
        void this.roomApi('POST', '/admit', { all: true }).then(() => this.pollState());
        return;
      case 'send-chat':
        if (typeof action.text === 'string' && typeof action.to === 'string') void this.sendChat(action.text, action.to);
        return;
      case 'chat-to':
        if (typeof action.to === 'string') {
          this.chatTo = action.to;
          this.emit();
        }
        return;
      case 'mark-chat-read':
        this.lastRead = this.messages.length ? this.messages[this.messages.length - 1]!.createdAt : new Date().toISOString();
        this.emit();
        return;
      case 'leave':
        void this.leave();
        return;
      case 'end':
        if (this.sharing) {
          this.notice = 'Stop sharing first. The class window comes back, and you can end the class from there.';
          this.emit();
          return;
        }
        void this.end();
        return;
      case 'open-share':
        return;
      default:
        return;
    }
  }

  /**
   * Publish the helper's Windows.Graphics.Capture session. There is no
   * getDisplayMedia video fallback: that path paints excluded windows black.
   */
  private async tryNativeCapture(input: ShareRequest): Promise<{ track: MediaStreamTrack | null; abort: boolean }> {
    if (this.opts.plan.mode !== 'wgc-exclude' || this.opts.plan.mask) {
      this.notice = 'Screen share stays off until Windows.Graphics.Capture can leave the classroom panels out of the picture.';
      this.emit();
      return { track: null, abort: true };
    }
    let consumer: WgcHandle;
    try {
      consumer = openWgcTrack();
    } catch {
      this.notice = 'This window could not open the capture preview, so nothing was shared.';
      this.emit();
      return { track: null, abort: true };
    }
    this.wgcHandle = consumer;
    const started = await desktop().startWgc({
      kind: input.kind === 'window' ? 'window' : 'monitor',
      sourceId: input.source.id,
      displayId: input.source.displayId,
    });
    if (!started.ok) {
      consumer.stop();
      this.wgcHandle = null;
      this.notice = started.error.startsWith('Run Capture test')
        ? started.error
        : `Windows.Graphics.Capture did not start (${started.error}). Nothing was shared, and the panels were not painted black.`;
      this.emit();
      return { track: null, abort: true };
    }
    this.opts.plan = {
      ...this.opts.plan,
      mode: 'wgc-exclude',
      mask: false,
      label: started.label,
      detail: started.detail,
    };
    this.shareDisplayId = started.displayId || input.source.displayId;
    await Promise.race([consumer.ready, sleep(2500)]);
    return { track: consumer.track, abort: false };
  }

  async beginShare(input: ShareRequest): Promise<void> {
    const allowed = shareAllowed(this.opts.plan, input.kind);
    if (!allowed.ok) {
      this.notice = allowed.reason;
      this.emit();
      return;
    }
    if (!this.room) return;
    const audioPromise = input.systemAudio ? this.captureSystemAudio() : null;
    const epoch = ++this.shareEpoch;
    let raw: MediaStreamTrack | null = null;
    const native = await this.tryNativeCapture(input);
    if (epoch !== this.shareEpoch) {
      native.track?.stop();
      this.releaseCapture();
      return;
    }
    if (native.abort) {
      this.releaseCapture();
      return;
    }
    raw = native.track;
    if (!raw) {
      this.releaseCapture();
      if (audioPromise) void this.discardAudio(audioPromise);
      if (!this.notice) this.notice = 'Screen share did not start, so nothing was sent to students.';
      this.emit();
      return;
    }
    if (epoch !== this.shareEpoch) {
      raw.stop();
      this.releaseCapture();
      if (audioPromise) void this.discardAudio(audioPromise);
      return;
    }
    try {
      raw.contentHint = 'detail';
    } catch {
      /* ignore */
    }
    raw.addEventListener('ended', () => {
      if (this.shareRaw === raw) void this.stopShare();
    });
    this.shareRaw = raw;
    let media: MediaStreamTrack = raw;
    if (epoch !== this.shareEpoch) {
      this.releaseCapture();
      return;
    }
    if (input.kind === 'region') {
      if (!input.region || !input.display) {
        this.releaseCapture();
        this.notice = 'Drag a region to share.';
        this.emit();
        return;
      }
      await sleep(80);
      const crop = cropTrack(media, input.region, input.display);
      if (!crop) {
        this.releaseCapture();
        this.notice = 'Could not crop that region.';
        this.emit();
        return;
      }
      this.shareCrop = crop;
      media = crop.track;
    }
    const settings = raw.getSettings();
    const width = input.kind === 'region' && input.region ? input.region.w : settings.width;
    const height = input.kind === 'region' && input.region ? input.region.h : settings.height;
    const simulcast = screenShareSimulcastFor(width, height);
    const published = new LocalVideoTrack(media, undefined, true);
    const shareOpts = (layered: boolean) => ({
      name: 'screen',
      source: Track.Source.ScreenShare,
      simulcast: layered,
      screenShareEncoding: { maxBitrate: SCREEN_SHARE.encoding.maxBitrate, maxFramerate: SCREEN_SHARE.encoding.maxFramerate },
      degradationPreference: 'maintain-resolution' as RTCDegradationPreference,
      screenShareSimulcastLayers: layered
        ? SCREEN_SHARE.layers.map((l) => new VideoPreset(l.width, l.height, l.maxBitrate, l.maxFramerate))
        : undefined,
    });
    try {
      await this.room.localParticipant.publishTrack(published, shareOpts(simulcast));
    } catch (err) {
      if (!simulcast || media.readyState !== 'live') {
        published.stop();
        this.releaseCapture();
        this.notice = 'Could not start the screen share.';
        console.warn('screen share', err);
        this.emit();
        return;
      }
      await this.room.localParticipant.unpublishTrack(published, false).catch(() => undefined);
      try {
        await this.room.localParticipant.publishTrack(published, shareOpts(false));
      } catch (err2) {
        published.stop();
        this.releaseCapture();
        this.notice = 'Could not start the screen share.';
        console.warn('screen share', err2);
        this.emit();
        return;
      }
    }
    if (epoch !== this.shareEpoch) {
      await this.stopPublished(published);
      this.releaseCapture();
      return;
    }
    this.screenTrack = published;
    this.previewTrack = media;
    this.sharing = true;
    this.strokes = [];
    void desktop().annotationOpen(this.shareDisplayId || input.source.displayId);
    void this.publishAnnotateSnapshot();
    this.shareKind = input.kind;
    this.overlayRect = input.kind === 'region' ? input.region : input.kind === 'screen' ? input.display : null;
    if (audioPromise) await this.publishSystemAudio(audioPromise);
    await this.roomApi('POST', '/stage', { mode: 'screen' });
    this.showStudentVideos = true;
    desktop().minimizeMain();
    this.emit();
  }

  /** Started synchronously from the share click so the user gesture is still active. */
  private captureSystemAudio(): Promise<MediaStream | null> {
    const promise = navigator.mediaDevices
      .getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      } as DisplayMediaStreamOptions)
      .catch(() => null);
    this.pendingAudio = promise;
    return promise;
  }

  private async discardAudio(promise: Promise<MediaStream | null>): Promise<void> {
    const stream = await promise;
    stream?.getTracks().forEach((track) => track.stop());
  }

  private async publishSystemAudio(promise: Promise<MediaStream | null>): Promise<void> {
    this.pendingAudio = null;
    const stream = await promise;
    if (!stream || !this.room || !this.sharing) {
      stream?.getTracks().forEach((track) => track.stop());
      if (this.sharing) this.notice = 'Video is sharing. System audio was not included.';
      return;
    }
    for (const track of stream.getVideoTracks()) track.stop();
    const audio = stream.getAudioTracks()[0];
    if (!audio) {
      this.notice = 'Video is sharing. System audio was not included.';
      return;
    }
    const local = new LocalAudioTrack(audio);
    try {
      await this.room.localParticipant.publishTrack(local, {
        name: 'screen_audio',
        source: Track.Source.ScreenShareAudio,
        audioPreset: AudioPresets.music,
        dtx: false,
        red: false,
      });
      this.screenAudio = local;
    } catch {
      local.stop();
      this.notice = 'Video is sharing. System audio was not included.';
    }
  }

  async shareRegion(
    display: { id: number; x: number; y: number; w: number; h: number },
    source: ShareRequest['source'],
    systemAudio = false
  ): Promise<void> {
    const win = window.open(
      `app://classroom/region.html?x=${display.x}&y=${display.y}&w=${display.w}&h=${display.h}`,
      'region-picker',
      `left=${Math.round(display.x)},top=${Math.round(display.y)},width=${Math.round(display.w)},height=${Math.round(display.h)}`
    );
    const rect = await new Promise<{ x: number; y: number; w: number; h: number } | null>((resolve) => {
      const timer = window.setTimeout(() => {
        this.regionWait = null;
        resolve(null);
      }, 120000);
      this.regionWait = (chosen) => {
        clearTimeout(timer);
        this.regionWait = null;
        resolve(chosen);
      };
    });
    if (win && !win.closed) win.close();
    if (!rect) return;
    await this.beginShare({
      kind: 'region',
      source,
      display: { x: display.x, y: display.y, w: display.w, h: display.h },
      region: rect,
      systemAudio,
    });
  }

  destroy(): void {
    window.removeEventListener('message', this.onMessage);
    this.unsubBounds?.();
    this.unsubWgcEnded?.();
    desktop().setClassActive(false);
    void this.stopRoom();
  }

  private emit(): void {
    this.chatTo = resolveChatRecipient(this.chatTo === 'all' ? 'all' : this.chatTo, this.studentIds());
    this.lastCells = this.computeCells();
    if (this.sharing) this.ensureStudentCameras();
    this.host.onView(this.view());
    this.paintTiles();
    this.pushHud();
  }

  private async leave(): Promise<void> {
    this.expectDisconnect = true;
    await this.roomApi('POST', '/leave');
    await this.stopRoom();
    desktop().setClassActive(false);
    this.host.onLeft();
  }

  private async end(): Promise<void> {
    if (this.sharing) {
      this.notice = 'Stop sharing first. The class window comes back, and you can end the class from there.';
      this.emit();
      return;
    }
    const ok = await desktop().confirmEnd();
    if (!ok) return;
    this.expectDisconnect = true;
    await this.roomApi('POST', '/end');
    this.ended = true;
    await this.stopRoom();
    desktop().setClassActive(false);
    this.host.onView(this.view());
  }

  private async enterHandoff(kind: 'device' | 'session', reason: string | null): Promise<void> {
    if (this.handoff || this.ended) return;
    this.expectDisconnect = true;
    await this.stopRoom();
    if (kind === 'session') {
      const copy = endedSessionCopy(isEndedReason(reason) ? reason : 'signed_out');
      this.handoff = { kind, title: copy.title, body: copy.body };
    } else {
      this.handoff = {
        kind,
        title: 'Class continued on another device',
        body: 'The class is open on another device. Use this device instead to take it back.',
      };
    }
    this.connecting = false;
    this.host.onView(this.view());
  }

  private markEnded(): void {
    if (this.ended) return;
    this.ended = true;
    this.expectDisconnect = true;
    void this.stopRoom().then(() => {
      desktop().setClassActive(false);
      this.host.onView(this.view());
    });
  }

  private async stopRoom(): Promise<void> {
    this.gen += 1;
    if (this.rotationTimer) window.clearInterval(this.rotationTimer);
    this.rotationTimer = 0;
    if (this.cameraTimer) window.clearInterval(this.cameraTimer);
    this.cameraTimer = 0;
    this.mirror.stop();
    if (this.annotateTimer) window.clearTimeout(this.annotateTimer);
    this.annotateTimer = 0;
    this.shareEpoch += 1;
    await this.dropScreen();
    this.releaseCapture();
    await this.dropMic();
    await this.dropCam();
    this.clearHost(this.dockHost);
    this.showStudentVideos = false;
    this.closeVideos();
    this.closeAnnotate();
    const room = this.room;
    this.room = null;
    this.sharing = false;
    this.annotateOn = false;
    this.pushHud();
    if (room) {
      room.removeAllListeners();
      await room.disconnect().catch(() => undefined);
    }
  }

  private bindRoom(room: Room): void {
    room.on(RoomEvent.Disconnected, (reason) => {
      if (this.expectDisconnect || this.ended) return;
      if (reason === DisconnectReason.DUPLICATE_IDENTITY || reason === DisconnectReason.PARTICIPANT_REMOVED) {
        void this.enterHandoff('device', null);
      }
    });
    room.on(RoomEvent.TrackPublished, () => this.ensureStudentCameras());
    room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      if (isHidden(participant.identity)) {
        void pub.setSubscribed(false);
        return;
      }
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach();
        document.getElementById('audio')?.appendChild(el);
      }
      if (track.kind === Track.Kind.Video) {
        this.ensureStudentCameras();
        this.emit();
      }
    });
    room.on(RoomEvent.TrackUnpublished, () => {
      this.ensureStudentCameras();
      this.emit();
    });
    room.on(RoomEvent.ParticipantDisconnected, () => this.emit());
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach();
      this.emit();
    });
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => this.onSpeakers(speakers));
    room.on(RoomEvent.TrackMuted, (pub, participant) => {
      this.onMuted(pub.source, participant);
      if (pub.source === Track.Source.Camera) this.emit();
    });
    room.on(RoomEvent.TrackUnmuted, (pub) => {
      if (pub.source === Track.Source.Camera) this.ensureStudentCameras();
      this.emit();
    });
    room.on(RoomEvent.ParticipantConnected, () => {
      this.ensureStudentCameras();
      void this.publishAnnotateSnapshot();
    });
    room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (participant?.isLocal) return;
      if (topic === 'cls-state') this.kickState();
      else if (topic === 'chat') this.kickChat();
      else if (topic === ANNOTATE_TOPIC) this.onRemoteAnnotate(payload);
    });
    room.on(RoomEvent.ConnectionStateChanged, () => this.emit());
  }

  private onSpeakers(speakers: Participant[]): void {
    const students = this.studentIdentities();
    const visible = new Set(this.snap?.visibleIdentities ?? []);
    let top: string | null = null;
    for (const s of speakers) {
      if (s.isLocal || isHidden(s.identity) || !students.has(s.identity)) continue;
      if (this.micMuted(s)) {
        this.sticky.delete(s.identity);
        continue;
      }
      this.sticky.add(s.identity);
      if (!top) top = s.identity;
      if (!visible.has(s.identity)) this.postSpeakPin(s.identity, true);
    }
    this.speakingId = top;
    this.emit();
  }

  private onMuted(source: Track.Source, participant: Participant): void {
    if (source !== Track.Source.Microphone) return;
    if (!this.studentIdentities().has(participant.identity)) return;
    this.sticky.delete(participant.identity);
    this.postSpeakPin(participant.identity, false);
    if (this.speakingId === participant.identity) this.speakingId = null;
    this.emit();
  }

  private micMuted(p: Participant): boolean {
    if (!p.isMicrophoneEnabled) return true;
    const pub = p.getTrackPublication(Track.Source.Microphone);
    return !pub || pub.isMuted;
  }

  private postSpeakPin(identity: string, pinned: boolean): void {
    if (pinned) {
      const last = this.pinTimes.get(identity) ?? 0;
      if (Date.now() - last < 2000) return;
    }
    this.pinTimes.set(identity, Date.now());
    void this.roomApi('POST', '/sample/pin', { identity, pinned });
  }

  private studentIdentities(): Set<string> {
    return new Set((this.snap?.admitted ?? []).filter((p) => p.role === 'STUDENT').map((p) => p.livekitIdentity));
  }

  private publishingPool(): string[] {
    if (!this.room) return [];
    const live: string[] = [];
    for (const p of this.room.remoteParticipants.values()) {
      if (this.mediaStreamFor(p.identity)) live.push(p.identity);
    }
    return liveStudentPool({
      visibleIdentities: this.snap?.visibleIdentities ?? [],
      admittedStudentIds: [...this.studentIdentities()],
      liveCameraIds: live,
    });
  }

  /**
   * Subscribe every admitted student's camera and keep the ones in the
   * current mosaic flowing. Off-stage cameras stay subscribed so the 8s
   * rotation can bring them back. During a share the main window is
   * minimized, and adaptive stream would otherwise pause every tile.
   */
  private ensureStudentCameras(): void {
    if (!this.room) return;
    const students = this.studentIdentities();
    const stage = new Set<string>();
    for (const id of this.mosaic) stage.add(id);
    for (const cell of this.lastCells) {
      if (cell.key !== '__self__' && !cell.key.startsWith('blank-')) stage.add(cell.key);
    }
    for (const p of this.room.remoteParticipants.values()) {
      if (p.isLocal || isHidden(p.identity)) continue;
      if (students.size && !students.has(p.identity)) continue;
      const pub = p.getTrackPublication(Track.Source.Camera);
      if (!pub) continue;
      const remote = pub as {
        isDesired?: boolean;
        isSubscribed: boolean;
        setSubscribed: (on: boolean) => void;
        setEnabled?: (on: boolean) => void;
        setVideoDimensions?: (size: { width: number; height: number }) => void;
      };
      try {
        const wanted = remote.isDesired === undefined ? !remote.isSubscribed : remote.isDesired === false;
        if (wanted) remote.setSubscribed(true);
      } catch {
        /* the publication can already be closing */
      }
      if (!this.sharing || !stage.has(p.identity)) continue;
      try {
        remote.setEnabled?.(true);
        remote.setVideoDimensions?.({ width: 320, height: 180 });
      } catch {
        /* audio publications do not take a video size */
      }
    }
  }

  private computeCells(): { key: string; label: string }[] {
    const pool = this.publishingPool();
    const cap = studentCapForLayout(this.opts.layout);
    const pins = orderedPins(
      (this.snap?.admitted ?? [])
        .filter((p) => p.role === 'STUDENT' && p.pinned)
        .map((p) => ({ identity: p.livekitIdentity, pinnedAt: p.pinnedAt ?? 0 })),
      pool,
      cap
    );
    const sticky = [...this.sticky].filter((id) => pool.includes(id));
    const picked = selectStudentTiles({
      pool,
      teacherPins: pins,
      speakingId: this.speakingId,
      sticky,
      prevMosaic: this.mosaic,
      rotationTick: this.rotationTick,
      lastTick: this.lastTick,
      studentSlots: cap,
    });
    this.mosaic = picked.mosaic;
    this.lastTick = picked.lastTick;
    return tileCells(picked.tiles, this.opts.layout).map((key, index) => ({
      key: key ?? `blank-${index}`,
      label: !key ? '' : key === '__self__' ? 'You' : this.nameOf(key),
    }));
  }

  private nameOf(identity: string): string {
    return (
      this.snap?.admitted.find((p) => p.livekitIdentity === identity)?.displayName ||
      this.room?.remoteParticipants.get(identity)?.name ||
      'Student'
    );
  }

  private paintTiles(): void {
    if (this.sharing) {
      this.clearHost(this.dockHost);
      if (this.showStudentVideos) void this.paintVideos(this.lastCells);
      else this.closeVideos();
      return;
    }
    this.closeVideos();
    this.paintHost(this.dockHost, this.lastCells, 'dock');
  }

  private async paintVideos(cells: { key: string; label: string }[]): Promise<void> {
    if (!this.showStudentVideos || !this.sharing) return;
    const grid = await this.ensureVideos();
    if (!this.showStudentVideos || !this.sharing || !grid) {
      if (!this.showStudentVideos) this.closeVideos();
      return;
    }
    this.paintHost(grid, cells, 'share');
  }

  private async ensureVideos(): Promise<HTMLElement | null> {
    if (this.videosWin && !this.videosWin.closed && this.videosGrid?.isConnected) return this.videosGrid;
    this.videosWin = window.open('app://classroom/videos.html', 'classroom-videos', 'width=640,height=420');
    if (!this.videosWin) return null;
    const grid = await this.waitFor(() => {
      try {
        return this.videosWin && !this.videosWin.closed ? this.videosWin.document.getElementById('grid') : null;
      } catch {
        return null;
      }
    });
    this.videosGrid = grid;
    return grid;
  }

  private async toggleVideos(): Promise<void> {
    if (this.showStudentVideos && this.videosOpen()) {
      this.showStudentVideos = false;
      this.closeVideos();
      this.emit();
      return;
    }
    this.showStudentVideos = true;
    await this.paintVideos(this.lastCells);
    this.emit();
  }

  private closeVideos(): void {
    this.mirror.stop();
    this.clearHost(this.videosGrid);
    this.videosGrid = null;
    if (this.videosWin && !this.videosWin.closed) this.videosWin.close();
    this.videosWin = null;
  }

  private tileModel(cells: { key: string; label: string }[]): VideoModel {
    return {
      slots: this.opts.layout,
      cells: cells.map((cell) => this.cellMeta(cell)),
    };
  }

  private cellMeta(cell: { key: string; label: string }): VideoCell {
    if (cell.key === '__self__' || cell.key.startsWith('blank-')) {
      return { key: cell.key, label: cell.label, pinned: false, canPin: false, participantId: null };
    }
    const person = this.snap?.admitted.find((p) => p.livekitIdentity === cell.key && p.role === 'STUDENT');
    return {
      key: cell.key,
      label: cell.label,
      pinned: !!person?.pinned,
      canPin: !!person,
      participantId: person?.id ?? null,
    };
  }

  private videosOpen(): boolean {
    try {
      return !!this.videosWin && !this.videosWin.closed;
    } catch {
      return false;
    }
  }

  private videosApi(host: HTMLElement): VideosApi | null {
    const view = host.ownerDocument.defaultView as (Window & { classroomVideos?: VideosApi }) | null;
    return view?.classroomVideos ?? null;
  }

  private paintHost(host: HTMLElement | null, cells: { key: string; label: string }[], where: 'dock' | 'share'): void {
    if (!host) return;
    if (where === 'share') {
      const api = this.videosApi(host);
      if (api) {
        api.setModel(this.tileModel(cells));
        const keys = cells.map((cell) => cell.key);
        api.whenPainted(() => {
          if (host.isConnected && this.showStudentVideos && this.sharing) this.mirror.sync(keys);
        });
        return;
      }
    }
    const doc = host.ownerDocument;
    const spec = videoGrid(this.opts.layout, where);
    if (where === 'dock') {
      const style = dockGridStyle(this.opts.layout);
      host.style.gridTemplateColumns = style.gridTemplateColumns;
      host.style.gridTemplateRows = style.gridTemplateRows;
    } else {
      host.style.gridTemplateColumns = `repeat(${spec.cols}, minmax(0, 1fr))`;
      host.style.gridTemplateRows = `repeat(${spec.rows}, minmax(0, 1fr))`;
    }
    const keep = new Set<string>();
    for (const cell of cells) {
      keep.add(cell.key);
      let tile = [...host.children].find((n) => (n as HTMLElement).dataset.key === cell.key) as HTMLElement | undefined;
      if (!tile) {
        tile = doc.createElement('div');
        tile.className = 'tile';
        tile.dataset.key = cell.key;
        const video = doc.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        if (cell.key === '__self__') video.muted = true;
        const cap = doc.createElement('div');
        cap.className = 'cap';
        tile.append(video, cap);
        const meta = this.cellMeta(cell);
        if (meta.canPin && meta.participantId) {
          const pin = doc.createElement('button');
          pin.type = 'button';
          pin.className = 'peer-pin-btn';
          pin.title = 'Pin: keep this student in the panel';
          pin.addEventListener('click', () => {
            const now = this.cellMeta(cell);
            if (!now.participantId) return;
            this.handle({ type: 'pin', id: now.participantId, pinned: !now.pinned });
          });
          tile.append(pin);
        }
      }
      const meta = this.cellMeta(cell);
      const pin = tile.querySelector('.peer-pin-btn');
      if (pin) {
        pin.textContent = meta.pinned ? 'Unpin' : 'Pin';
        pin.setAttribute('aria-label', meta.pinned ? `Unpin ${cell.label}` : `Pin ${cell.label} (keep in the panel)`);
      }
      const cap = tile.querySelector('.cap');
      if (cap) cap.textContent = cell.label;
      const empty = cell.key.startsWith('blank-');
      let placeholder = tile.querySelector('.empty');
      if (empty && !placeholder) {
        placeholder = doc.createElement('div');
        placeholder.className = 'empty';
        placeholder.textContent = 'Waiting for video';
        tile.append(placeholder);
      }
      if (!empty && placeholder) placeholder.remove();
      host.append(tile);
    }
    this.attachCells(host, cells);
    for (const child of [...host.querySelectorAll('.tile')]) {
      const key = (child as HTMLElement).dataset.key || '';
      if (!keep.has(key)) {
        this.attach(key, null);
        child.remove();
      }
    }
  }

  private attachCells(host: HTMLElement, cells: { key: string }[]): void {
    for (const cell of cells) {
      const tile = [...host.querySelectorAll('.tile')].find((n) => (n as HTMLElement).dataset.key === cell.key);
      const video = tile?.querySelector('video');
      if (video instanceof HTMLVideoElement) this.attach(cell.key, cell.key.startsWith('blank-') ? null : video);
    }
  }

  private clearHost(host: HTMLElement | null): void {
    if (!host) return;
    for (const child of [...host.querySelectorAll('.tile')]) {
      this.attach((child as HTMLElement).dataset.key || '', null);
      child.remove();
    }
  }

  private mediaStreamFor(key: string): MediaStreamTrack | null {
    if (!key || key.startsWith('blank-')) return null;
    if (key === '__self__') {
      if (!this.camOn || !this.camTrack) return null;
      const media = this.camTrack.mediaStreamTrack;
      return media && media.readyState !== 'ended' ? media : null;
    }
    const pub = this.room?.remoteParticipants.get(key)?.getTrackPublication(Track.Source.Camera);
    if (!pub || pub.isMuted || !pub.track) return null;
    const media = pub.track.mediaStreamTrack;
    return media && media.readyState !== 'ended' ? media : null;
  }

  private mediaFor(key: string): TrackLike | null {
    if (key.startsWith('blank-')) return null;
    if (key === '__self__') return this.camOn ? this.camTrack : null;
    const pub = this.room?.remoteParticipants.get(key)?.getTrackPublication(Track.Source.Camera);
    if (!pub || pub.isMuted || !pub.track) return null;
    return pub.track as RemoteTrack;
  }

  private attach(key: string, el: HTMLVideoElement | null): void {
    const track = el ? this.mediaFor(key) : null;
    const prev = this.attached.get(key);
    if (prev?.el === el && prev.track === track) return;
    if (prev) {
      try {
        prev.track.detach(prev.el);
      } catch {
        /* ignore */
      }
      this.attached.delete(key);
    }
    if (!el || !track) return;
    track.attach(el);
    this.attached.set(key, { track, el });
  }

  private async syncMic(): Promise<void> {
    if (!this.room || !this.micOn || this.micTrack) return;
    let track: LocalAudioTrack;
    try {
      try {
        track = await createLocalAudioTrack(this.opts.micId ? { deviceId: { exact: this.opts.micId } } : {});
      } catch {
        track = await createLocalAudioTrack();
      }
    } catch {
      this.micOn = false;
      this.notice = 'Could not start the microphone.';
      this.emit();
      return;
    }
    if (!this.room || !this.micOn) {
      track.stop();
      return;
    }
    await this.room.localParticipant.publishTrack(track, {
      source: Track.Source.Microphone,
      audioPreset: AudioPresets.speech,
      dtx: true,
      red: true,
    });
    this.micTrack = track;
    this.emit();
  }

  private async syncCam(): Promise<void> {
    if (!this.room || !this.camOn || this.camTrack) return;
    const video: MediaTrackConstraints = {
      width: { ideal: TEACHER_CAMERA.capture.width },
      height: { ideal: TEACHER_CAMERA.capture.height },
      frameRate: { ideal: TEACHER_CAMERA.capture.frameRate, max: TEACHER_CAMERA.capture.frameRate },
    };
    if (this.opts.camId) video.deviceId = { exact: this.opts.camId };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: video.width, height: video.height, frameRate: video.frameRate },
      });
    }
    const media = stream.getVideoTracks()[0];
    if (!media || !this.room || !this.camOn) {
      media?.stop();
      return;
    }
    const track = new LocalVideoTrack(media, undefined, true);
    const layers = TEACHER_CAMERA.layers.map((l) => new VideoPreset(l.width, l.height, l.maxBitrate, l.maxFramerate));
    try {
      await this.room.localParticipant.publishTrack(track, {
        source: Track.Source.Camera,
        simulcast: true,
        videoEncoding: { maxBitrate: TEACHER_CAMERA.encoding.maxBitrate, maxFramerate: TEACHER_CAMERA.encoding.maxFramerate },
        videoSimulcastLayers: layers,
      });
    } catch (err) {
      console.warn('camera', err);
      track.stop();
      this.camOn = false;
      this.notice = 'Could not start the camera.';
      this.emit();
      return;
    }
    this.camTrack = track;
    this.emit();
  }

  private async dropMic(): Promise<void> {
    const track = this.micTrack;
    this.micTrack = null;
    if (track) await this.stopPublished(track);
  }

  private async dropCam(): Promise<void> {
    const track = this.camTrack;
    this.camTrack = null;
    if (track) await this.stopPublished(track);
    this.attach('__self__', null);
  }

  private async dropScreen(): Promise<void> {
    const track = this.screenTrack;
    this.screenTrack = null;
    if (track) await this.stopPublished(track);
  }

  private async stopPublished(track: LocalAudioTrack | LocalVideoTrack): Promise<void> {
    try {
      await this.room?.localParticipant.unpublishTrack(track, false);
    } catch {
      /* already unpublished */
    }
    try {
      track.stop();
    } catch {
      /* simulcast track may already be gone */
    }
  }

  private async stopShare(): Promise<void> {
    if (!this.sharing && !this.screenTrack && !this.shareRaw) return;
    this.shareEpoch += 1;
    this.sharing = false;
    this.showStudentVideos = false;
    this.shareKind = null;
    this.annotateOn = false;
    await this.dropScreen();
    this.releaseCapture();
    this.closeAnnotate();
    this.closeVideos();
    this.strokes = [];
    if (this.code) await this.roomApi('POST', '/stage', { mode: 'idle' });
    this.emit();
  }

  private releaseCapture(): void {
    const wgc = this.wgcHandle;
    this.wgcHandle = null;
    this.shareDisplayId = '';
    this.shareCrop?.stop();
    const raw = this.shareRaw;
    const pending = this.pendingAudio;
    this.shareCrop = null;
    this.shareRaw = null;
    this.previewTrack = null;
    this.pendingAudio = null;
    const audio = this.screenAudio;
    this.screenAudio = null;
    wgc?.stop();
    void desktop().stopWgc();
    if (pending) void this.discardAudio(pending);
    if (audio) void this.stopPublished(audio);
    try {
      raw?.stop();
    } catch {
      /* ignore */
    }
  }

  private async toggleAnnotate(): Promise<void> {
    if (!this.sharing) return;
    this.annotateOn = !this.annotateOn;
    desktop().annotationActive(this.annotateOn);
    this.emit();
  }

  /** Closes the overlay. Turning annotation off only makes it click-through. */
  private closeAnnotate(): void {
    this.annotateOn = false;
    void desktop().annotationClose();
    this.annotateWin = null;
  }

  private async publishAnnotate(msg: AnnotateMsg): Promise<void> {
    if (!this.room) return;
    if (packetTooBig(msg)) {
      console.warn('[annotate] packet over 14000 bytes, not sent');
      return;
    }
    try {
      await this.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(msg)), {
        reliable: true,
        topic: ANNOTATE_TOPIC,
      });
    } catch (err) {
      console.warn('annotate', err);
    }
  }

  private async publishAnnotateSnapshot(): Promise<void> {
    if (!this.room || !this.sharing) return;
    const from = this.room.localParticipant.identity || 'teacher';
    const msg: AnnotateMsg = { v: 1, type: 'snapshot', strokes: this.strokes, from };
    await this.publishAnnotate(msg);
    void this.roomApi('PUT', '/annotate', { strokes: fitSnapshot(this.strokes) });
  }

  private async onAnnotate(msg: AnnotateMsg): Promise<void> {
    if (!msg || msg.v !== 1) return;
    this.strokes = applyAnnotateOp(this.strokes, msg);
    if (!this.room) return;
    await this.publishAnnotate(msg);
    if (this.annotateTimer) window.clearTimeout(this.annotateTimer);
    this.annotateTimer = window.setTimeout(() => {
      const strokes = fitSnapshot(this.strokes);
      void this.roomApi('PUT', '/annotate', { strokes });
    }, 400);
  }

  private onRemoteAnnotate(payload: Uint8Array): void {
    try {
      const msg = JSON.parse(new TextDecoder().decode(payload)) as unknown;
      desktop().annotationCommand({ op: 'remote', msg });
    } catch {
      /* ignore malformed packets */
    }
  }

  private studentIds(): Set<string> {
    return new Set((this.snap?.admitted ?? []).filter((p) => p.role === 'STUDENT').map((p) => p.id));
  }

  private async sendChat(text: string, to: string): Promise<void> {
    const body = text.trim().slice(0, 2000);
    if (!body) return;
    const resolved = resolveChatRecipient(to === 'all' ? 'all' : to, this.studentIds());
    this.chatTo = resolved;
    const res = await this.roomApi('POST', '/messages', { text: body, to: resolved });
    if (!res || res.status >= 400) this.notice = errorText(res?.data, 'Could not send the message.');
    this.chatTo = resolveChatRecipient(this.chatTo === 'all' ? 'all' : this.chatTo, this.studentIds());
    await this.pollChat();
  }

  private kickState(): void {
    this.pushLive = true;
    void this.pollState();
  }

  private kickChat(): void {
    this.pushLive = true;
    void this.pollChat();
  }

  private async loops(gen: number): Promise<void> {
    const state = async () => {
      while (this.gen === gen) {
        await this.pollState();
        await sleep(statePollMs(this.pushLive));
      }
    };
    const chat = async () => {
      while (this.gen === gen) {
        await this.pollChat();
        await sleep(chatPollMs(this.pushLive));
      }
    };
    void state();
    void chat();
  }

  private async pollState(): Promise<void> {
    if (!this.code || !this.room) return;
    const res = await this.roomApi('GET', '/state');
    if (!res || res.status >= 400) return;
    const snap = parseRoomState(res.data);
    if (!snap) return;
    if (snap.ended) {
      this.markEnded();
      return;
    }
    this.snap = snap;
    if (!this.clearedStaleStage && snap.stageMode === 'screen' && !this.sharing) {
      this.clearedStaleStage = true;
      void this.roomApi('POST', '/stage', { mode: 'idle' });
    }
    this.noteAttention();
    this.emit();
  }

  private async pollChat(): Promise<void> {
    if (!this.code || !this.room) return;
    const res = await this.roomApi('GET', '/messages');
    if (!res || res.status >= 400) return;
    const list = res.data && typeof res.data === 'object' && Array.isArray((res.data as { messages?: unknown }).messages)
      ? ((res.data as { messages: ChatMessage[] }).messages)
      : [];
    this.messages = mergeMessages(this.messages, list).slice(-500);
    this.noteAttention();
    this.emit();
  }

  private noteAttention(): void {
    const waiting = this.snap?.waiting ?? [];
    const students = (this.snap?.admitted ?? []).filter((p) => p.role === 'STUDENT');
    if (!this.attentionReady) {
      this.prevWaiting = waiting;
      this.prevStudents = students;
      this.prevMessages = this.messages;
      this.attentionReady = true;
      return;
    }
    const events = attentionEvents({
      prevWaiting: this.prevWaiting,
      nextWaiting: waiting,
      prevStudents: this.prevStudents,
      nextStudents: students,
      prevMessages: this.prevMessages,
      nextMessages: this.messages,
      myParticipantId: this.snap?.meId ?? null,
    });
    this.prevWaiting = waiting;
    this.prevStudents = students;
    this.prevMessages = this.messages;
    for (const event of events) {
      if (event.type === 'waiting') desktop().notify('Student waiting', `${event.name} is in the waiting room`);
      else if (event.type === 'hand') desktop().notify('Hand raised', `${event.name} raised a hand`);
      else if (event.type === 'focus') desktop().notify(event.label, event.name);
      else desktop().notify(`Message from ${event.name}`, event.text);
    }
  }

  private async roomApi(method: string, suffix: string, body?: unknown): Promise<{ status: number; data: unknown } | null> {
    if (!this.code) return null;
    const res = await desktop().api(method, `/api/rooms/${encodeURIComponent(this.code)}${suffix}`, body);
    if (res.status === 401) {
      const reason = res.data && typeof res.data === 'object' && 'reason' in res.data ? String((res.data as { reason: unknown }).reason) : null;
      await this.enterHandoff('session', reason);
      return null;
    }
    if (res.status === 410) {
      this.markEnded();
      return null;
    }
    return res;
  }

  private async refreshDevices(): Promise<void> {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      this.devices = list
        .filter((d): d is MediaDeviceInfo & { kind: 'audioinput' | 'videoinput' } => d.kind === 'audioinput' || d.kind === 'videoinput')
        .map((d) => ({
          id: d.deviceId,
          label: d.label || (d.kind === 'audioinput' ? 'Microphone' : 'Camera'),
          kind: d.kind,
        }));
    } catch {
      this.devices = [];
    }
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private pushHud(): void {
    const students = (this.snap?.admitted ?? []).filter((p) => p.role === 'STUDENT');
    const oldest = oldestWaiting(this.snap?.waiting ?? []);
    const snap: PanelSnapshot = {
      hud: {
        inClass: !this.ended && !this.handoff,
        sharing: this.sharing,
        shareKind: this.shareKind,
        captureMode: this.opts.plan.mode,
        captureLabel: this.opts.plan.label,
        captureDetail: this.opts.plan.detail,
        micOn: this.micOn,
        camOn: this.camOn,
        annotateOn: this.annotateOn,
        videosOn: !!this.videosWin && !this.videosWin.closed,
        waitingRoomOn: this.snap ? this.snap.waitingRoomOn : true,
        layout: this.opts.layout,
        classLabel: this.snap?.classLabel || this.code,
        waitingCount: this.snap?.waiting.length ?? 0,
        hands: students.filter((s) => s.handRaised).length,
        focusAlerts: countFocusAlerts(students),
        unread: unreadCount(this.messages, this.lastRead, this.snap?.meId ?? null),
        oldestWaitingId: oldest?.id ?? null,
        oldestWaitingName: oldest?.displayName ?? null,
      },
      admitted: this.snap?.admitted ?? [],
      waiting: this.snap?.waiting ?? [],
      messages: this.messages.slice(-100),
      chatTo: this.chatTo,
      meId: this.snap?.meId ?? null,
      devices: this.devices,
      micId: this.opts.micId,
      camId: this.opts.camId,
    };
    desktop().pushHud(snap);
  }

  private waitFor<T>(read: () => T | null, ms = 2500): Promise<T | null> {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const value = read();
        if (value) {
          resolve(value);
          return;
        }
        if (Date.now() - start > ms) {
          resolve(null);
          return;
        }
        setTimeout(tick, 30);
      };
      tick();
    });
  }
}

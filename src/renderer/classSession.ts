/**
 * Teacher class: the same server calls and LiveKit publish options as the
 * website. Screen video is Windows.Graphics.Capture only, so excluded classroom
 * windows are left out of the picture instead of painted black.
 * The session cookie and the LiveKit token stay out of logs.
 */

import { cropFractions, type SidecarRequest } from '../shared/sidecar';
import { WindowsWhiteboard } from './whiteboardHost';
import { MEDIA_PREFS_KEY, parseMediaPrefs, serializeMediaPrefs } from '../shared/mediaPrefs';
import { LOW_POWER_KEY, capEncodingFps, parseLowPower, shareFps, tileProfile } from '../shared/lowPower';
/** B6: how long the 'joined from another device' notice stays up. */
export const TAKEOVER_NOTICE_MS = 8000;
import { freshTakeovers, takeoverToastText, type TakeoverNotice } from '../shared/web/deviceTakeover';
import { createEraseBatcher } from '../shared/web/eraseBatch';
import { createPanelReporter, panelShownWin } from '../shared/panelReport';
import { withoutStrokes } from '../shared/studentErase';
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
  type Participant,
  type RemoteTrack,
} from 'livekit-client';
import type { ChromeBounds, DeviceInfo, PanelSnapshot } from '../shared/actions';
import {
  admitFailureNotice,
  chatPollSuffix,
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
import {
  SCREEN_SHARE,
  parseProfile,
  teacherCameraFor,
  videoModeShare,
  type MediaProfileName,
  dockGridStyle,
  inkRectFor,
  screenShareSimulcastFor,
  shareAllowed,
  windowsShareEncodings,
  type CapturePlan,
  type ShareKind,
} from '../shared/capture';
import { VIDEO_MODE_OFF, type VideoModeState } from '../shared/videoMode';
import { AudioRegistry } from '../shared/web/audioPolicy';
import { createVoiceTrack, onVoiceStatus, saveVoiceSettings, voiceSettings, voiceStatus } from '../shared/web/audio/voiceProcessor';
import { DUCK_IDLE, HEADPHONES_HINT, MicDuckProcessor, duckStep, trackLevelMeter, type DuckState } from '../shared/web/micDuck';
import { SHARE_AUDIO_ECHO_WARNING, desktopLoopbackConstraints, toggleShareAudio, wantShareAudio, type ShareAudioChoice } from '../shared/shareAudio';
import { DRAW_TOPIC, applyPacket, decodePacket, isDrawColor, validStrokeId, type Stroke } from '../shared/web/drawLogic';
import { SHARE_CODEC, setMediaProfile, shareProfile } from '../shared/web/videoQuality';
import type { VideoCell, VideoModel } from '../shared/videoModel';
import { openWgcTrack, type WgcHandle } from './wgcTrack';
import { setReportClassCode } from './errorReporter';
import { applyDrawBytes } from '../shared/studentInk';
import { CONNECT_RETRY_NOTICE, connectRetryDelayMs } from '../shared/connectRetry';
import { drawIdentitySet, routeLivePacket } from '../shared/livePackets';
import {
  liveStudentPool,
  orderedPins,
  selectStudentTiles,
  sortRoster,
  studentCapForLayout,
  sampleCapForLayout,
  readyPool,
  fillStudentSlots,
  presentStudents,
  dockTileSize,
  visibleCells,
  videoGrid,
  type SlotCount,
} from '../shared/classLogic';
import { ShareMirror, type MirrorPainter } from './videoMirror';
import { attentionEvents, countFocusAlerts, decideHandoff, endedSessionCopy, isEndedReason, settledShareNotice } from '../shared/session';
import { oldestWaiting } from '../shared/waiting';
import { desktop } from './bridge';
import { cropTrack, type CropHandle } from './cropTrack';

type TrackLike = {
  attach: (el: HTMLMediaElement) => HTMLMediaElement;
  detach: (el?: HTMLMediaElement) => HTMLMediaElement[];
};

export type ClassView = {
  phase: 'connecting' | 'live' | 'handoff' | 'ended';
  /** Last class session seen in /state (the ENDED answer may not carry it). */
  classSessionId: string | null;
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
  whiteboardOn?: boolean;
  /** Share is in Video mode (30 fps, motion). */
  videoMode: boolean;
  /** Video mode follows the screen's motion (auto-detect) until the teacher toggles it. */
  videoModeAuto: boolean;
  /** Student allowed to draw now, and the drawing on the share. */
  drawHolder: RoomSnapshot['drawHolder'];
  drawStrokes: number;
  drawRequests: number;
  devices: DeviceInfo[];
  micId: string;
  camId: string;
  audioBlocked: boolean;
  /** The share stopped on its own (capture/recovery failed): show "Share stopped — click to restart". */
  shareStopped: boolean;
};

type ShareRequest = {
  kind: ShareKind;
  source: { id: string; displayId: string; name: string; kind: 'screen' | 'window' };
  display: { x: number; y: number; w: number; h: number } | null;
  region: { x: number; y: number; w: number; h: number } | null;
  systemAudio?: boolean;
};

/** Share to resume after the teacher leaves and rejoins the same class (survives a new controller). */
let resumeShare: { code: string; input: ShareRequest } | null = null;

type VideosApi = MirrorPainter & {
  setModel: (model: VideoModel) => void;
  whenPainted: (cb: () => void) => void;
};

type Host = {
  onView: (view: ClassView) => void;
  onLeft: () => void;
  onLogin: (message: string) => void;
};

/** Admin observers, and this app's own native share sidecar (`teacher_…__screen`: never subscribe, never echo its loopback audio). */
const HIDDEN = /^(adminobserver_|adminpreview_)|^teacher_.*__screen$/;

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

/** "A" or "A, B": every student drawing now. */
function drawHolderNames(snap: { drawHolders?: { name: string }[]; drawHolder?: { name: string } | null } | null): string | null {
  const names = (snap?.drawHolders?.length ? snap.drawHolders : snap?.drawHolder ? [snap.drawHolder] : []).map((h) => h.name);
  return names.length ? names.join(', ') : null;
}

const RESUMING_NOTICE = 'Resuming your screen share…';
const RESTARTING_NOTICE = 'Restarting the screen share…';

export class ClassController {
  private room: Room | null = null;
  private code = '';
  private gen = 0;
  private snap: RoomSnapshot | null = null;
  /** draw-allow pushes seen since the last /state (identity → on). */
  private drawAllowPushes = new Map<string, boolean>();
  private messages: ChatMessage[] = [];
  private chatTo = 'all';
  private lastRead: string | null = null;
  private notice = '';
  private micOn = false;
  private camOn = false;
  private sharing = false;
  private whiteboard: WindowsWhiteboard | null = null;
  /** Student videos open with a share, and stay closed after the teacher dismisses them. */
  private showStudentVideos = false;
  /** Whiteboard window's meeting bar: re-rendered on every panel snapshot. */
  private wbListeners = new Set<() => void>();
  private wbSnap: PanelSnapshot | null = null;
  /** Remote audio players, keyed by track sid (see AudioRegistry). */
  private nextAudioTrack: RemoteTrack | null = null;
  readonly audioEls = new AudioRegistry<{ el: HTMLMediaElement; track: RemoteTrack }>(
    () => {
      const track = this.nextAudioTrack!;
      const el = track.attach();
      el.dataset.audioSid = track.sid ?? '';
      document.getElementById('audio')?.appendChild(el);
      return { el, track };
    },
    ({ el, track }) => {
      track.detach(el);
      el.remove();
    }
  );

  private pruneAudio(room: Room): void {
    const live: string[] = [];
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.audioTrackPublications.values()) if (pub.isSubscribed && pub.track) live.push(pub.trackSid);
    }
    this.audioEls.prune(live);
  }
  private unsubSidecarAudio: (() => void) | null = null;
  private unsubSidecarLevel: (() => void) | null = null;
  /** B1: mic ducking while the share's computer sound plays (see micDuck.ts). */
  private duck: {
    on: boolean;
    busy: boolean;
    proc: MicDuckProcessor | null;
    ctx: AudioContext | null;
    meter: { db: () => number; stop: () => void } | null;
    timer: number;
    state: DuckState;
    sysDb: number;
    sysAt: number;
    track: LocalAudioTrack | null;
  } = { on: false, busy: false, proc: null, ctx: null, meter: null, timer: 0, state: DUCK_IDLE, sysDb: -120, sysAt: 0, track: null };
  /** Sidecar reported process loopback that leaves out this app's sound. */
  private sidecarAudioExcludes = false;
  private shareKind: ShareKind | null = null;
  private annotateOn = false;
  private connecting = false;
  private ended = false;
  private expectDisconnect = false;
  private handoff: ClassView['handoff'] = null;
  /** Server pushes (cls-state nudges, chat packets) can arrive: LiveKit is connected (as the web's usePushLive). */
  private get pushLive(): boolean {
    return this.room?.state === ConnectionState.Connected;
  }
  private stateInflight = false;
  /** The share is published by the native sidecar (frames never enter this window). */
  private viaSidecar = false;
  private sidecarAudio = false;
  /** Last share request, for "click to restart" and resume after rejoin. */
  private lastShare: ShareRequest | null = null;
  private shareStopped = false;
  private classSessionId: string | null = null;
  /** Server media profile from the token response ('low' on a small server / shared uplink). */
  private mediaProfile: MediaProfileName = 'standard';
  private lowPower = (() => {
    try {
      return parseLowPower(localStorage.getItem(LOW_POWER_KEY));
    } catch {
      return false;
    }
  })();
  private takeoverSeen = Date.now();
  private stateAgain = false;
  private clearedStaleStage = false;
  private audioBlocked = false;
  private devices: DeviceInfo[] = [];
  private micTrack: LocalAudioTrack | null = null;
  private camTrack: LocalVideoTrack | null = null;
  private screenTrack: LocalVideoTrack | null = null;
  private shareRaw: MediaStreamTrack | null = null;
  private screenAudio: LocalAudioTrack | null = null;
  private pendingAudio: Promise<MediaStream | null> | null = null;
  /** Computer sound: follows Video mode ('auto') unless the teacher chose with the Sound button. */
  private audioChoice: ShareAudioChoice = 'auto';
  private audioAskedAtStart = false;
  private audioSyncing = false;
  private shareCrop: CropHandle | null = null;
  private previewTrack: MediaStreamTrack | null = null;
  private overlayRect: { x: number; y: number; w: number; h: number } | null = null;
  /** Shared picture inside the overlay's monitor, 0..1 (region shares are a part of it). */
  private inkRect = { x: 0, y: 0, w: 1, h: 1 };
  private shareEpoch = 0;
  private chain: Promise<void> = Promise.resolve();
  private mosaic: string[] = [];
  private lastTick = 0;
  private rotationTick = 0;
  private rotationTimer = 0;
  private cameraTimer = 0;
  private readonly mirror = new ShareMirror(
    () => this.videosPainter(),
    (key, jpeg) => desktop().postVideoTile(key, jpeg),
    (key) => this.mediaStreamFor(key)
  );
  private emitTimer = 0;
  private lastHud = '';
  private videoMode: VideoModeState = { ...VIDEO_MODE_OFF };
  private videoTimer = 0;
  private drawStrokes: Stroke[] = [];
  private drawLoadSeq = 0;
  private prevDrawRequests = new Set<string>();
  private speakingId: string | null = null;
  private sticky = new Set<string>();
  private pinTimes = new Map<string, number>();
  private dockHost: HTMLElement | null = null;
  private videosWin: Window | null = null;
  private videosGrid: HTMLElement | null = null;
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
  private unsubWgcStatus: (() => void) | null = null;
  private unsubInkEdit: (() => void) | null = null;
  private unsubVoice: (() => void) | null = null;

  /** Devices panel: the saved noise-removal choice and what the mic runs now. */
  private voiceSnapshot(): NonNullable<PanelSnapshot['voice']> {
    const s = voiceSettings(true);
    const st = voiceStatus();
    return { noise: s.noise, focus: s.focus, label: st?.label ?? 'Applies when your microphone is on', note: st?.note };
  }

  constructor(
    private readonly opts: { layout: SlotCount; micId: string; camId: string; plan: CapturePlan },
    private readonly host: Host
  ) {
    this.onMessage = (ev: MessageEvent) => {
      if (ev.origin !== location.origin || !ev.data || typeof ev.data !== 'object') return;
      const data = ev.data as { channel?: string; rect?: { x: number; y: number; w: number; h: number } };
      if (data.channel === 'region-picked') this.regionWait?.(data.rect ?? null);
      if (data.channel === 'region-cancel') this.regionWait?.(null);
    };
    window.addEventListener('message', this.onMessage);
    this.unsubVoice = onVoiceStatus(() => this.emit());
    this.unsubBounds = desktop().onChromeBounds((bounds) => {
      this.bounds = bounds;
    });
    this.unsubWgcEnded = desktop().onWgcEnded((reason) => {
      // Sidecar shares have no wgcHandle in this window: they must stop too, or the
      // UI keeps showing Stop while nothing is published (trial 2026-10-14).
      if (this.sharing && (this.wgcHandle || this.viaSidecar)) void this.shareFailed(reason);
    });
    this.unsubPanels = desktop().onPanelWindows((st) => {
      this.panelWindows = { main: st?.main !== false, videos: st?.videos === true };
      this.emit();
    });
    this.unsubSidecarAudio =
      desktop().onSidecarAudio?.((m) => {
        const r = (m ?? {}) as { ok?: boolean; why?: string };
        this.sidecarAudioExcludes = r.ok === true;
        if (r.ok !== true && this.sharing && this.sidecarAudio) {
          this.notice = "Computer sound is not available on this PC (needs Windows 10 version 2004 or newer), so it was not sent. Your students' voices are never sent back.";
          this.emit();
        }
      }) ?? null;
    this.unsubSidecarLevel =
      desktop().onSidecarAudioLevel?.((db) => {
        const n = Number(db);
        if (Number.isFinite(n)) {
          this.duck.sysDb = n;
          this.duck.sysAt = performance.now();
        }
      }) ?? null;
    this.unsubInkEdit = desktop().onStudentInkEdit((edit) => this.onStudentInkEdit(edit ?? {}));
    this.unsubWgcStatus = desktop().onWgcStatus((status) => {
      if (!this.sharing) return;
      if (status.state === 'recovering' && status.attempt === 1) {
        this.notice = 'The display changed: restarting the screen capture…';
        this.emit();
      } else if (status.state === 'recovered') {
        this.notice = 'Screen capture restarted. Students see your screen again.';
        this.emit();
      } else if (status.state === 'failed') {
        void this.shareFailed(status.reason);
      }
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
      classSessionId: this.classSessionId,
      whiteboardOn: !!this.whiteboard,
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
      videoMode: this.videoMode.on,
      videoModeAuto: this.videoMode.auto,
      drawHolder: this.snap?.drawHolder ?? null,
      drawStrokes: this.drawStrokes.length,
      drawRequests: this.snap?.drawRequestCount ?? 0,
      devices: this.devices,
      micId: this.opts.micId,
      camId: this.opts.camId,
      audioBlocked: this.audioBlocked,
      shareStopped: this.shareStopped && !this.sharing,
    };
  }

  async start(code: string): Promise<void> {
    await this.stopRoom();
    this.code = code.toUpperCase();
    setReportClassCode(this.code);
    this.panelReporter.reset();
    this.ended = false;
    this.handoff = null;
    this.expectDisconnect = false;
    this.shareStopped = false;
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
    const makeRoom = () => new Room({
      disconnectOnPageLeave: false,
      // Off on purpose: during a share no <video> is attached in this window,
      // so adaptive stream reported every camera as invisible (0x0) and paused
      // it. ensureStudentCameras() enables exactly the tiles on stage instead.
      adaptiveStream: false,
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
    // Should-change: a failed first connect retries with a fresh token and backoff.
    let room: Room | null = null;
    for (let attempt = 0; ; attempt++) {
      const tokenRes = await desktop().api('GET', `/api/rooms/${encodeURIComponent(this.code)}/token`);
      if (this.gen !== gen) return;
      if (tokenRes.status === 401) {
        const reason = tokenRes.data && typeof tokenRes.data === 'object' && 'reason' in tokenRes.data ? String((tokenRes.data as { reason: unknown }).reason) : null;
        await this.enterHandoff('session', reason);
        return;
      }
      const body = (tokenRes.data ?? {}) as { token?: unknown; url?: unknown; error?: unknown; mediaProfile?: unknown };
      const tokenOk = tokenRes.status === 200 && typeof body.token === 'string' && typeof body.url === 'string';
      if (tokenOk) {
        // Server MEDIA_PROFILE: 'low' caps Video mode and the camera like the web app.
        this.mediaProfile = parseProfile(body.mediaProfile);
        setMediaProfile(this.mediaProfile);
      }
      // 4xx other than 401 (ended / forbidden / not found) will not get better: stop now.
      if (!tokenOk && tokenRes.status >= 400 && tokenRes.status < 500) {
        this.connecting = false;
        this.notice = errorText(tokenRes.data, 'Could not join the class.');
        this.emit();
        return;
      }
      if (tokenOk) {
        const r = makeRoom();
        this.room = r;
        this.bindRoom(r);
        try {
          await r.connect(body.url as string, body.token as string, { autoSubscribe: true, peerConnectionTimeout: 20_000 });
          await r.startAudio().catch(() => undefined);
          room = r;
        } catch {
          console.warn('connect failed', { attempt });
          this.expectDisconnect = true;
          await r.disconnect().catch(() => undefined);
          this.expectDisconnect = false;
          if (this.room === r) this.room = null;
        }
      }
      if (this.gen !== gen) return;
      if (room) break;
      const wait = connectRetryDelayMs(attempt);
      if (wait === null) {
        this.connecting = false;
        this.notice = tokenOk ? 'Could not connect to the class.' : errorText(tokenRes.data, 'Could not join the class.');
        this.emit();
        return;
      }
      this.notice = CONNECT_RETRY_NOTICE;
      this.emit();
      await new Promise((r) => window.setTimeout(r, wait));
      if (this.gen !== gen) return;
    }
    if (this.notice === CONNECT_RETRY_NOTICE) this.notice = '';
    if (this.gen !== gen) return;
    this.connecting = false;
    this.audioBlocked = room.canPlaybackAudio === false;
    const resume = resumeShare;
    resumeShare = null;
    if (resume && resume.code === this.code) {
      // Teacher left while sharing and rejoined: share the same source again.
      window.setTimeout(() => {
        if (this.gen === gen && !this.sharing && this.room) {
          this.notice = RESUMING_NOTICE;
          this.emit();
          void this.beginShare(resume.input).finally(() => this.settleProgressNotice(RESUMING_NOTICE));
        }
      }, 1500);
    }
    // 1c: restore the teacher's own mic/camera choice after a rejoin or restart.
    const prefs = this.loadMediaPrefs();
    this.micOn = prefs.mic;
    this.camOn = prefs.cam;
    if (this.micOn) await this.enqueue(() => this.syncMic());
    if (this.camOn) void this.enqueue(async () => { await this.syncCam(); this.emit(); });
    await this.refreshDevices();
    await this.roomApi('PATCH', '/settings', { maxVisibleVideos: sampleCapForLayout(this.opts.layout) });
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

  private loadMediaPrefs() {
    try {
      return parseMediaPrefs(localStorage.getItem(MEDIA_PREFS_KEY));
    } catch {
      return parseMediaPrefs(null);
    }
  }

  private saveMediaPrefs(): void {
    try {
      localStorage.setItem(MEDIA_PREFS_KEY, serializeMediaPrefs({ mic: this.micOn, cam: this.camOn }));
    } catch {
      /* ignore */
    }
  }

  handle(action: { type: string; [key: string]: unknown }): void {
    switch (action.type) {
      case 'toggle-mic':
        this.micOn = !this.micOn;
        this.saveMediaPrefs();
        void this.enqueue(async () => {
          if (this.micOn) await this.syncMic();
          else await this.dropMic();
          this.emit();
        });
        this.emit();
        return;
      case 'toggle-cam':
        this.camOn = !this.camOn;
        this.saveMediaPrefs();
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
      case 'set-voice':
        // Saved on this PC (localStorage, shared with the other app windows);
        // the mic is republished with the new chain.
        if ((action.noise !== 'standard' && action.noise !== 'enhanced' && action.noise !== 'strong') || typeof action.focus !== 'boolean') return;
        saveVoiceSettings({ noise: action.noise, focus: action.focus });
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
      case 'toggle-whiteboard':
        void this.toggleWhiteboard();
        return;
      case 'toggle-low-power':
        this.lowPower = !this.lowPower;
        try {
          localStorage.setItem(LOW_POWER_KEY, this.lowPower ? '1' : '0');
        } catch {
          /* ignore */
        }
        void this.applyVideoMode(this.videoMode.on);
        this.ensureStudentCameras();
        this.emit();
        break;
      case 'toggle-video-mode':
                void this.applyVideoMode(!this.videoMode.on);
        return;
      case 'toggle-share-audio':
        if (!this.sharing) return;
        this.audioChoice = toggleShareAudio(!!this.screenAudio);
        void this.syncShareAudio();
        return;
      case 'draw-allow':
        if (typeof action.id === 'string') void this.drawAction({ action: 'allow', participantId: action.id });
        return;
      case 'draw-revoke':
        void this.drawAction(typeof action.id === 'string' ? { action: 'revoke', participantId: action.id } : { action: 'revoke' });
        return;
      case 'draw-clear':
        void this.drawAction({ action: 'clear' });
        return;
      case 'layout':
        if (action.slots === 2 || action.slots === 4 || action.slots === 6) {
          this.opts.layout = action.slots;
          void desktop().saveLayout(action.slots);
          void this.roomApi('PATCH', '/settings', { maxVisibleVideos: sampleCapForLayout(action.slots) });
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
        if (typeof action.id === 'string') void this.admit({ participantIds: [action.id] });
        return;
      case 'admit-all':
        void this.admit({ all: true });
        return;
      case 'spotlight':
        if (action.id === null || typeof action.id === 'string') void this.setSpotlight(action.id);
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
  /**
   * Option A: a token for the native share sidecar (`<teacher>__screen`).
   * Null (older server, error) means the Electron publish path.
   */
  private async sidecarRequest(input: ShareRequest): Promise<SidecarRequest | null> {
    if (localStorage.getItem('classroom.sidecar') === 'off') return null;
    const res = await this.roomApi('POST', '/screen-token').catch(() => null);
    const data = res && res.status < 300 ? (res.data as { token?: unknown; url?: unknown }) : null;
    if (!data || typeof data.token !== 'string' || typeof data.url !== 'string') return null;
    const video = videoModeShare(this.mediaProfile);
    const fps = shareFps({ videoMode: false, lowPower: this.lowPower, slidesFps: SCREEN_SHARE.capture.frameRate, videoFps: video.capture.frameRate });
    return {
      url: data.url,
      token: data.token,
      code: this.code,
      crop: input.kind === 'region' ? cropFractions(input.region, input.display) : null,
      audio: !!input.systemAudio,
      fps,
      videoFps: shareFps({ videoMode: true, lowPower: this.lowPower, slidesFps: fps, videoFps: video.capture.frameRate }),
      profile: this.mediaProfile,
    };
  }

  private async tryNativeCapture(
    input: ShareRequest
  ): Promise<{ track: MediaStreamTrack | null; abort: boolean; sidecar?: boolean; helperFailed?: boolean }> {
    // 2026-10-18: no fail-closed gate here. If the startup probe said Graphics
    // Capture is unavailable, main re-probes in start-wgc; when it still fails,
    // helperFailed below drops to the Chromium backup capture (the pre-round-6
    // behaviour) so the share always starts.
    let consumer: WgcHandle;
    try {
      consumer = openWgcTrack();
    } catch {
      this.notice = 'This window could not open the capture preview, so nothing was shared.';
      this.emit();
      return { track: null, abort: true };
    }
    this.wgcHandle = consumer;
    const sidecar = await this.sidecarRequest(input);
    const started = await desktop().startWgc({
      kind: input.kind === 'window' ? 'window' : 'monitor',
      sourceId: input.source.id,
      displayId: input.source.displayId,
      ...(sidecar ? { sidecar } : {}),
    });
    if (!started.ok) {
      consumer.stop();
      this.wgcHandle = null;
      if (started.error.startsWith('Run Capture test') || started.error === 'denied') {
        this.notice = started.error;
        this.emit();
        return { track: null, abort: true };
      }
      this.notice = `Windows.Graphics.Capture did not start (${started.error}). Trying the backup capture…`;
      this.emit();
      return { track: null, abort: true, helperFailed: true };
    }
    this.opts.plan = {
      ...this.opts.plan,
      mode: 'wgc-exclude',
      mask: false,
      label: started.label,
      detail: started.detail,
    };
    this.shareDisplayId = started.displayId || input.source.displayId;
    if (started.publisher === 'sidecar') {
      // Frames go helper → sidecar → LiveKit; nothing to publish here.
      consumer.stop();
      this.wgcHandle = null;
      return { track: null, abort: false, sidecar: true };
    }
    await Promise.race([consumer.ready, sleep(2500)]);
    return { track: consumer.track, abort: false };
  }

  async beginShare(input: ShareRequest): Promise<void> {
    if (this.whiteboard) this.closeWhiteboard(false);
    const allowed = shareAllowed(this.opts.plan, input.kind);
    if (!allowed.ok) {
      this.notice = allowed.reason;
      this.emit();
      return;
    }
    if (!this.room) return;
    const audioPromise = input.systemAudio ? this.captureSystemAudio() : null;
    this.audioChoice = 'auto';
    this.audioAskedAtStart = !!input.systemAudio;
    const epoch = ++this.shareEpoch;
    let raw: MediaStreamTrack | null = null;
    const native = await this.tryNativeCapture(input);
    if (epoch !== this.shareEpoch) {
      native.track?.stop();
      this.releaseCapture();
      return;
    }
    let backup = false;
    if (native.abort && native.helperFailed) {
      // Trial 2026-10-14 (150 % scaling): the WGC helper timed out. Fall back to
      // Chromium desktop capture so the class still sees the screen.
      raw = await chromiumDesktopTrack(input.source.id);
      if (epoch !== this.shareEpoch) {
        raw?.stop();
        this.releaseCapture();
        return;
      }
      if (!raw) {
        this.releaseCapture();
        this.notice = 'Screen share did not start: neither Windows.Graphics.Capture nor the backup capture worked. Nothing was shared.';
        this.emit();
        return;
      }
      backup = true;
    } else if (native.abort) {
      this.releaseCapture();
      return;
    }
    if (native.sidecar) {
      if (audioPromise) void this.discardAudio(audioPromise);
      this.viaSidecar = true;
      this.sidecarAudio = !!input.systemAudio;
      this.screenTrack = null;
      this.previewTrack = null;
      this.sharing = true;
      this.shareStopped = false;
      this.lastShare = input;
      this.videoMode = { ...VIDEO_MODE_OFF };
      void desktop().annotationOpen(this.shareDisplayId || input.source.displayId);
      this.shareKind = input.kind;
      this.overlayRect = input.kind === 'region' ? input.region : input.kind === 'screen' ? input.display : null;
      this.inkRect = inkRectFor(input.kind, input.region, input.display);
      await this.roomApi('POST', '/stage', { mode: 'screen', desktopInk: true });
      this.drawStrokes = [];
      void this.loadDrawing();
      this.showStudentVideos = true;
      desktop().minimizeMain();
      this.emit();
      return;
    }
    if (!backup) raw = native.track;
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
    // VP9 L1T3 (+ VP8 backup for viewers without VP9), as the website (SHARE_CODEC).
    const shareOpts = (layered: boolean, vp9 = true) => ({
      name: 'screen',
      source: Track.Source.ScreenShare,
      ...(vp9
        ? { videoCodec: SHARE_CODEC.codec, scalabilityMode: SHARE_CODEC.scalabilityMode, backupCodec: { codec: SHARE_CODEC.backupCodec } }
        : {}),
      simulcast: layered || vp9,
      screenShareEncoding: { maxBitrate: SCREEN_SHARE.encoding.maxBitrate, maxFramerate: SCREEN_SHARE.encoding.maxFramerate },
      degradationPreference: 'maintain-resolution' as RTCDegradationPreference,
      screenShareSimulcastLayers: layered
        ? SCREEN_SHARE.layers.map((l) => new VideoPreset(l.width, l.height, l.maxBitrate, l.maxFramerate))
        : undefined,
    });
    try {
      await this.room.localParticipant.publishTrack(published, shareOpts(simulcast));
    } catch (err) {
      if (media.readyState !== 'live') {
        published.stop();
        this.releaseCapture();
        this.notice = 'Could not start the screen share.';
        console.warn('screen share', err);
        this.emit();
        return;
      }
      await this.room.localParticipant.unpublishTrack(published, false).catch(() => undefined);
      try {
        // Plain single-layer VP8: the most compatible publish.
        await this.room.localParticipant.publishTrack(published, shareOpts(false, false));
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
    this.shareStopped = false;
    this.lastShare = input;
    if (backup) this.notice = 'Sharing with the backup capture (Windows.Graphics.Capture did not start). Classroom windows may show as black boxes to students.';
    else if (this.notice.startsWith('Windows.Graphics.Capture did not start')) this.notice = '';
    if (this.lowPower) void this.applyVideoMode(false);
    this.videoMode = { ...VIDEO_MODE_OFF };
    void desktop().annotationOpen(this.shareDisplayId || input.source.displayId);
    this.shareKind = input.kind;
    this.overlayRect = input.kind === 'region' ? input.region : input.kind === 'screen' ? input.display : null;
    this.inkRect = inkRectFor(input.kind, input.region, input.display);
    if (audioPromise) await this.publishSystemAudio(audioPromise);
    // desktopInk: student drawing is painted on this desktop (captured
    // overlay), so the website skips its own stroke layer (no double ink).
    await this.roomApi('POST', '/stage', { mode: 'screen', desktopInk: true });
    this.drawStrokes = [];
    void this.loadDrawing();
    this.showStudentVideos = true;
    desktop().minimizeMain();
    this.emit();
  }

  /** Started synchronously from the share click so the user gesture is still active. */
  private captureSystemAudio(): Promise<MediaStream | null> {
    // Desktop loopback via getUserMedia needs no user gesture (Video mode is
    // toggled from another window or automatically). getDisplayMedia is the
    // fallback and only works inside a click in this window.
    const promise = navigator.mediaDevices
      .getUserMedia(desktopLoopbackConstraints())
      .then((stream) => (stream.getAudioTracks().length ? stream : (stream.getTracks().forEach((t) => t.stop()), null)))
      .catch((err) => {
        console.warn('desktop loopback audio', err);
        return null;
      })
      .then(
        (stream) =>
          stream ??
          navigator.mediaDevices
            .getDisplayMedia({
              video: true,
              audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
            } as DisplayMediaStreamOptions)
            .catch(() => null)
      );
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
    this.unsubWgcStatus?.();
    this.unsubSidecarAudio?.();
    this.unsubSidecarLevel?.();
    this.unsubInkEdit?.();
    this.unsubInkEdit = null;
    this.unsubVoice?.();
    this.unsubVoice = null;
    this.unsubPanels?.();
    this.unsubPanels = null;
    desktop().setClassActive(false);
    void this.stopRoom();
  }

  /**
   * Coalesced: speaker changes, polls and track events can fire dozens of
   * times a second, and each emit re-renders the class view and sends the
   * HUD snapshot to every floating window. One emit per ~16 ms is plenty.
   */
  private emit(): void {
    if (this.emitTimer) return;
    this.emitTimer = window.setTimeout(() => {
      this.emitTimer = 0;
      this.emitNow();
    }, 16);
  }

  /** Cameras on demand: report the student-video panel to the server (web /video-panel). */
  private panelWindows = { main: true, videos: false };
  /** Eraser deletes, coalesced (one eraser drag hits the same strokes many times). */
  /** Teacher eraser over student ink: deduped, one POST /draw {action:'erase', ids:[≤50]} per flush (web eraseBatch). */
  private eraseQueue = createEraseBatcher((body) => this.roomApi('POST', '/draw', body));
  private unsubPanels: (() => void) | null = null;

  private panelReporter = createPanelReporter((open) => {
    if (this.code) void this.roomApi('POST', '/video-panel', { open });
  });

  /** The student-video panel the teacher can see right now (cameras on demand, tile pause). */
  private panelShownNow(): boolean {
    return panelShownWin({
      sharing: this.floatingVideos,
      showStudentVideos: this.showStudentVideos,
      videosOpen: this.videosOpen(),
      videosHidden: !this.panelWindows.videos,
      mainHidden: !this.panelWindows.main,
    });
  }

  private syncPanelReport(): void {
    if (!this.code || !this.room) return;
    const videosHidden = !this.panelWindows.videos;
    this.panelReporter.update(
      panelShownWin({
        sharing: this.floatingVideos,
        showStudentVideos: this.showStudentVideos,
        videosOpen: this.videosOpen(),
        videosHidden,
        mainHidden: !this.panelWindows.main,
      })
    );
  }

  /** Computer sound is being sent with the share (sidecar or Electron path). */
  private sendingShareAudio(): boolean {
    return this.sharing && (this.viaSidecar ? this.sidecarAudio : !!this.screenAudio);
  }

  /** B1: attach / detach the mic ducker to match "computer sound is being sent". */
  private async syncDuck(): Promise<void> {
    const d = this.duck;
    if (d.busy) return;
    const want = this.sendingShareAudio() && !!this.micTrack;
    if (want === d.on && (!want || d.track === this.micTrack)) return;
    d.busy = true;
    try {
      if (d.on) {
        window.clearInterval(d.timer);
        d.timer = 0;
        d.meter?.stop();
        d.meter = null;
        await d.track?.stopProcessor().catch(() => undefined);
        await d.ctx?.close().catch(() => undefined);
        d.proc = null;
        d.ctx = null;
        d.track = null;
        d.on = false;
        d.state = { ...DUCK_IDLE, everDucked: d.state.everDucked };
      }
      if (want && this.micTrack) {
        const track = this.micTrack;
        const ctx = new AudioContext({ latencyHint: 'interactive' });
        track.setAudioContext(ctx);
        const proc = new MicDuckProcessor();
        await track.setProcessor(proc as never);
        d.ctx = ctx;
        d.proc = proc;
        d.track = track;
        d.meter = !this.viaSidecar && this.screenAudio ? trackLevelMeter(ctx, this.screenAudio.mediaStreamTrack) : null;
        d.on = true;
        d.timer = window.setInterval(() => {
          const now = performance.now();
          const sys = d.meter ? d.meter.db() : now - d.sysAt < 400 ? d.sysDb : -120;
          const next = duckStep(d.state, sys, proc.micDb(), now);
          if (next.gain !== d.state.gain) proc.setGain(next.gain);
          if (next.everDucked && !d.state.everDucked) {
            this.notice = HEADPHONES_HINT;
            this.emit();
          }
          d.state = next;
        }, 50);
      }
    } catch (e) {
      console.warn('mic duck', e); // never block the mic: it just is not ducked
    } finally {
      d.busy = false;
    }
  }

  private emitNow(): void {
    void this.syncDuck();
    this.syncPanelReport();
    this.chatTo = resolveChatRecipient(this.chatTo === 'all' ? 'all' : this.chatTo, this.studentIds());
    this.lastCells = this.computeCells();
    this.ensureStudentCameras();
    this.host.onView(this.view());
    this.paintTiles();
    this.pushHud();
    if (this.wbListeners.size) {
      this.wbSnap = this.panelSnapshot(); // cached: useSyncExternalStore needs a stable snapshot
      for (const cb of this.wbListeners) cb();
    }
  }

  private async leave(): Promise<void> {
    resumeShare = this.sharing && this.lastShare && this.code ? { code: this.code, input: this.lastShare } : null;
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
    resumeShare = null;
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
    if (this.whiteboard) this.closeWhiteboard(false);
    this.gen += 1;
    if (this.rotationTimer) window.clearInterval(this.rotationTimer);
    this.rotationTimer = 0;
    if (this.cameraTimer) window.clearInterval(this.cameraTimer);
    this.cameraTimer = 0;
    this.mirror.stop();
    this.audioEls.clear();
    this.stopVideoWatch();
    if (this.emitTimer) window.clearTimeout(this.emitTimer);
    this.emitTimer = 0;
    this.drawStrokes = [];
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
        // One <audio> per remote track sid: re-subscribes and reconnects never add a
        // second player (a doubled element = the same voice twice, slightly offset).
        this.nextAudioTrack = track;
        this.audioEls.attach(pub.trackSid || track.sid || `${participant.identity}:${pub.source}`, participant.identity === room.localParticipant.identity);
        this.nextAudioTrack = null;
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
    room.on(RoomEvent.TrackUnsubscribed, (track, pub, participant) => {
      if (track.kind === Track.Kind.Audio) this.audioEls.detach(pub.trackSid || track.sid || `${participant.identity}:${pub.source}`);
      else track.detach();
      this.emit();
    });
    room.on(RoomEvent.Reconnected, () => this.pruneAudio(room));
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => this.onSpeakers(speakers));
    room.on(RoomEvent.TrackMuted, (pub, participant) => {
      this.onMuted(pub.source, participant);
      if (pub.source === Track.Source.Camera) this.emit();
    });
    room.on(RoomEvent.TrackUnmuted, (pub) => {
      if (pub.source === Track.Source.Camera) this.ensureStudentCameras();
      this.emit();
    });
    room.on(RoomEvent.ParticipantConnected, () => this.ensureStudentCameras());
    room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (participant?.isLocal) return;
      const action = routeLivePacket(topic, participant?.identity, payload, {
        drawTopic: DRAW_TOPIC,
        drawIdentities: drawIdentitySet(this.snap?.drawHolders ?? [], this.drawAllowPushes),
      });
      if (action.kind === 'state') this.kickState();
      else if (action.kind === 'chat') this.kickChat();
      else if (action.kind === 'signal') {
        if (action.allow) this.drawAllowPushes.set(action.allow.identity, action.allow.on);
        this.kickState();
      } else if (action.kind === 'draw') this.onDrawPacket(payload);
    });
    room.on(RoomEvent.Reconnected, () => {
      if (this.sharing) void this.loadDrawing();
      this.ensureStudentCameras();
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
    const pool = liveStudentPool({
      visibleIdentities: this.snap?.visibleIdentities ?? [],
      admittedStudentIds: [...this.studentIdentities()],
      liveCameraIds: live,
    });
    const shown = this.lastCells.map((c) => c.key);
    return readyPool(
      pool,
      (id) => {
        const t = this.room?.remoteParticipants.get(id)?.getTrackPublication(Track.Source.Camera)?.track as { dimensions?: { width: number } } | undefined;
        return !!t?.dimensions?.width;
      },
      shown
    );
  }

  /**
   * Subscribe every admitted student's camera and keep the ones in the
   * current mosaic flowing. Off-stage cameras stay subscribed so the 8s
   * rotation can bring them back. adaptiveStream is off (see start()), so
   * this decides which cameras flow: the ones on stage.
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
      // adaptiveStream is off: enable the cameras on stage (dock or the
      // floating videos window), pause the rest. Students publish one small
      // layer, so the size is only a hint.
      try {
        // Paused while the panel showing them is hidden (floating window
        // hidden/closed during a share, main window minimized otherwise).
        const on = stage.has(p.identity) && this.panelShownNow();
        remote.setEnabled?.(on);
        if (on) {
          const tile = tileProfile(this.lowPower);
          remote.setVideoDimensions?.(tile.size);
          (remote as { setVideoFPS?: (fps: number) => void }).setVideoFPS?.(tile.fps);
        }
      } catch {
        /* the publication can already be closing */
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
    const live = new Set(pool);
    // Students who left (no longer in the LiveKit room) never take a "camera off" tile.
    const inRoom = new Set(this.room ? [...this.room.remoteParticipants.keys()] : []);
    const admitted = presentStudents(this.studentIdentities(), inRoom);
    const visible = (this.snap?.visibleIdentities ?? []).filter((id) => admitted.has(id) && !live.has(id));
    const others = [...admitted].filter((id) => !live.has(id) && !visible.includes(id));
    const students = fillStudentSlots(picked.tiles, [...visible, ...others], cap);
    return visibleCells(students, this.opts.layout).map((key) => ({
      key,
      label: key === '__self__' ? 'You' : live.has(key) ? this.nameOf(key) : `${this.nameOf(key)} · camera off`,
    }));
  }

  private nameOf(identity: string): string {
    return (
      this.snap?.admitted.find((p) => p.livekitIdentity === identity)?.displayName ||
      this.room?.remoteParticipants.get(identity)?.name ||
      'Student'
    );
  }

  /** Students' videos float in their own window while the stage is a share or the whiteboard. */
  private get floatingVideos(): boolean {
    return this.sharing || !!this.whiteboard;
  }

  private paintTiles(): void {
    if (this.floatingVideos) {
      this.clearHost(this.dockHost);
      if (this.showStudentVideos) void this.paintVideos(this.lastCells);
      else this.closeVideos();
      return;
    }
    this.closeVideos();
    this.paintHost(this.dockHost, this.lastCells, 'dock');
  }

  private async paintVideos(cells: { key: string; label: string }[]): Promise<void> {
    if (!this.showStudentVideos || !this.floatingVideos) return;
    const grid = await this.ensureVideos();
    if (!this.showStudentVideos || !this.floatingVideos || !grid) {
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

  /** Whiteboard and screen share are exclusive (students see one stage). */
  private async toggleWhiteboard(): Promise<void> {
    if (this.whiteboard) {
      this.whiteboard.stop();
      return;
    }
    const room = this.room;
    if (!room) return;
    if (this.sharing) await this.stopShare();
    const wb = new WindowsWhiteboard(
      room,
      room.localParticipant.identity,
      (m, s, b) => this.roomApi(m, s, b),
      () => {
        if (this.whiteboard === wb) this.whiteboard = null;
        if (!this.sharing) this.showStudentVideos = false;
        this.paintTiles();
        this.emit();
      },
      {
        snapshot: () => (this.wbSnap ??= this.panelSnapshot()),
        subscribe: (cb) => {
          this.wbListeners.add(cb);
          return () => this.wbListeners.delete(cb);
        },
        send: (a) => this.handle(a),
        togglePanel: (k) => desktop().togglePanel(k),
      }
    );
    this.whiteboard = wb;
    // Floating, draggable, minimisable student videos next to the board (like a share).
    this.showStudentVideos = true;
    this.paintTiles();
    this.emit();
    await wb.start();
  }

  private closeWhiteboard(clearSaved: boolean): void {
    const wb = this.whiteboard;
    this.whiteboard = null;
    wb?.stop(clearSaved);
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

  /** Paint target for the mirror: the videos popup's canvas API (same process). */
  private videosPainter(): MirrorPainter | null {
    try {
      if (!this.videosWin || this.videosWin.closed) return null;
      const api = (this.videosWin as Window & { classroomVideos?: VideosApi }).classroomVideos;
      return api && typeof api.paint === 'function' ? api : null;
    } catch {
      return null;
    }
  }

  private dockObserver: ResizeObserver | null = null;

  /** Same 2/4/6 arrangement and 16:9 tiles as the floating Student videos window, centred. */
  private sizeDock(host: HTMLElement): void {
    const t = dockTileSize({ w: host.clientWidth, h: host.clientHeight }, this.opts.layout);
    host.style.gridTemplateColumns = `repeat(${t.cols}, ${t.tileW}px)`;
    host.style.gridTemplateRows = `repeat(${t.rows}, ${t.tileH}px)`;
    host.style.justifyContent = 'center';
    host.style.alignContent = 'center';
    if (!this.dockObserver || (this.dockObserver as unknown as { host?: HTMLElement }).host !== host) {
      this.dockObserver?.disconnect();
      const obs = new ResizeObserver(() => {
        const n = dockTileSize({ w: host.clientWidth, h: host.clientHeight }, this.opts.layout);
        host.style.gridTemplateColumns = `repeat(${n.cols}, ${n.tileW}px)`;
        host.style.gridTemplateRows = `repeat(${n.rows}, ${n.tileH}px)`;
      });
      (obs as unknown as { host?: HTMLElement }).host = host;
      obs.observe(host);
      this.dockObserver = obs;
    }
  }

  private paintHost(host: HTMLElement | null, cells: { key: string; label: string }[], where: 'dock' | 'share'): void {
    if (!host) return;
    if (where === 'share') {
      const api = this.videosApi(host);
      if (api) {
        api.setModel(this.tileModel(cells));
        const keys = cells.map((cell) => cell.key);
        api.whenPainted(() => {
          if (host.isConnected && this.showStudentVideos && this.floatingVideos) this.mirror.sync(keys);
        });
        return;
      }
    }
    const doc = host.ownerDocument;
    const spec = videoGrid(this.opts.layout, where);
    if (where === 'dock') {
      this.sizeDock(host);
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
      // The web app's voice chain (noise removal + voice focus, falling back
      // to the browser-processed mic): src/shared/web/audio/voiceProcessor.ts.
      try {
        track = await createVoiceTrack(true, this.opts.micId ? { deviceId: { exact: this.opts.micId } } : undefined);
      } catch {
        track = await createVoiceTrack(true);
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
    const cam = teacherCameraFor(this.mediaProfile);
    const video: MediaTrackConstraints = {
      width: { ideal: cam.capture.width },
      height: { ideal: cam.capture.height },
      frameRate: { ideal: cam.capture.frameRate, max: cam.capture.frameRate },
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
    const layers = cam.layers.map((l) => new VideoPreset(l.width, l.height, l.maxBitrate, l.maxFramerate));
    try {
      await this.room.localParticipant.publishTrack(track, {
        source: Track.Source.Camera,
        simulcast: cam.simulcast,
        videoEncoding: { maxBitrate: cam.encoding.maxBitrate, maxFramerate: cam.encoding.maxFramerate },
        videoSimulcastLayers: layers.length ? layers : undefined,
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

  /** Capture or recovery failed for good: clear every "sharing" state and offer a one-click restart. */
  private async shareFailed(reason: string): Promise<void> {
    if (!this.sharing) return;
    const last = this.lastShare;
    await this.stopShare();
    this.lastShare = last;
    this.shareStopped = !!last;
    this.notice = `Share stopped${reason ? ` (${reason})` : ''}. Students no longer see your screen. Click "Restart share" to share again.`;
    desktop().restoreMain();
    desktop().notify('Share stopped', 'Students no longer see your screen. Click to restart.');
    this.emit();
  }

  /** "Share stopped — click to restart". */
  async restartShare(): Promise<void> {
    const last = this.lastShare;
    this.shareStopped = false;
    if (!last || this.sharing) {
      this.emit();
      return;
    }
    this.notice = RESTARTING_NOTICE;
    this.emit();
    await this.beginShare(last);
    this.settleProgressNotice(RESTARTING_NOTICE);
  }

  /**
   * A "Resuming / Restarting your screen share…" notice is progress, not
   * news: hide it once the share is back (it used to stay up after the
   * resume had worked). A failure keeps whatever beginShare reported.
   */
  private settleProgressNotice(progress: string): void {
    const next = settledShareNotice(this.notice, progress, this.sharing);
    if (next !== this.notice) {
      this.notice = next;
      this.emit();
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
    this.stopVideoWatch();
    this.videoMode = { ...VIDEO_MODE_OFF };
    this.drawStrokes = [];
    this.pushInk();
    if (this.code) await this.roomApi('POST', '/stage', { mode: 'idle' });
    this.emit();
  }

  private releaseCapture(): void {
    this.viaSidecar = false;
    this.sidecarAudio = false;
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
  }

  // —— Student drawing on the real desktop (desktop ink) ——

  private async drawAction(body: Record<string, unknown>): Promise<void> {
    const res = await this.roomApi('POST', '/draw', body);
    if (res && res.status >= 400) this.notice = errorText(res.data, 'Could not change drawing.');
    await this.pollState();
  }

  /** Snapshot for share start / reconnect; packets re-apply idempotently by index. */
  private async loadDrawing(): Promise<void> {
    const seq = ++this.drawLoadSeq;
    const res = await this.roomApi('GET', '/draw');
    if (seq !== this.drawLoadSeq || !this.sharing || !res || res.status >= 400) return;
    const data = (res.data ?? {}) as { strokes?: unknown };
    const strokes: Stroke[] = [];
    for (const raw of Array.isArray(data.strokes) ? data.strokes : []) {
      const st = (raw ?? {}) as Partial<Stroke>;
      if (!validStrokeId(st.id) || typeof st.by !== 'string' || !isDrawColor(st.color) || !Array.isArray(st.pts)) continue;
      const pts = st.pts.filter((n) => typeof n === 'number' && Number.isFinite(n));
      strokes.push({ id: st.id, by: st.by, name: typeof st.name === 'string' ? st.name : 'Student', color: st.color, pts });
    }
    this.drawStrokes = strokes;
    this.pushInk();
    this.emit();
  }

  private onDrawPacket(payload: Uint8Array): void {
    if (!this.sharing) return;
    const res = applyDrawBytes(this.drawStrokes, payload);
    if (!res.changed) return;
    this.drawStrokes = res.strokes;
    this.pushInk();
    if (res.kind !== 'pts') this.emit();
  }

  /** Teacher erased (eraser over a stroke) or cleared student ink on the desktop. */
  private onStudentInkEdit(edit: { erase?: string[]; clear?: boolean }): void {
    if (!this.sharing) return;
    if (edit.clear) {
      this.drawStrokes = [];
      this.pushInk();
      this.emit();
      void this.drawAction({ action: 'clear' });
      return;
    }
    const ids = (edit.erase ?? []).filter((id) => validStrokeId(id));
    if (!ids.length) return;
    this.drawStrokes = withoutStrokes(this.drawStrokes, ids);
    this.pushInk();
    this.emit();
    this.eraseQueue.add(ids);
  }

  private pushInk(): void {
    desktop().studentInk({ strokes: this.sharing ? this.drawStrokes : [], rect: this.inkRect });
  }

  // —— Video mode (30 fps, motion): manual only ——

  private stopVideoWatch(): void {
    if (this.videoTimer) window.clearInterval(this.videoTimer);
    this.videoTimer = 0;
  }

  /**
   * Video mode, like the website's share Video toggle: capture 30 fps (helper
   * restarted with the new rate), encoder hint `motion`, keep the resolution
   * under pressure, and the web's video bitrates. Off returns to this app's
   * slide settings. Share audio uses the system loopback stream.
   */
  private async applyVideoMode(on: boolean): Promise<void> {
    this.videoMode = { on, auto: false };
    const profile = shareProfile(on);
    const fps = shareFps({ videoMode: on, lowPower: this.lowPower, slidesFps: SCREEN_SHARE.capture.frameRate, videoFps: videoModeShare(this.mediaProfile).capture.frameRate });
    const raw = this.shareRaw;
    try {
      if (raw) raw.contentHint = profile.contentHint;
    } catch {
      /* ignore */
    }
    const sender = (this.screenTrack as unknown as { sender?: RTCRtpSender } | null)?.sender;
    if (sender) {
      try {
        const params = sender.getParameters();
        params.encodings = capEncodingFps(windowsShareEncodings(params.encodings ?? [], on, this.mediaProfile), fps);
        (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = profile.degradationPreference;
        await sender.setParameters(params);
      } catch (err) {
        console.warn('video mode encodings', err);
      }
    }
    if (this.viaSidecar) desktop().sidecarControl?.({ op: 'mode', videoMode: on });
    void desktop().setWgcFps(fps);
    await this.syncShareAudio();
    this.emit();
  }

  /** Publish or drop computer sound to match the Sound choice and Video mode. */
  private async syncShareAudio(): Promise<void> {
    if (this.viaSidecar) {
      // Sidecar: process loopback that leaves out this app's sound (never the echoing device loopback).
      const want = this.sharing && wantShareAudio({ choice: this.audioChoice, videoMode: this.videoMode.on, askedAtStart: this.audioAskedAtStart, excludesOwnOutput: true });
      if (want !== this.sidecarAudio) {
        this.sidecarAudio = want;
        desktop().sidecarControl?.({ op: 'audio', on: want });
      }
      this.emit();
      return;
    }
    if (this.audioSyncing) return;
    this.audioSyncing = true;
    try {
      for (let i = 0; i < 3; i++) {
        // Electron fallback: desktop loopback = the WHOLE output incl. students' voices this app plays,
        // so it is only sent when the teacher explicitly turns it on (and is warned).
        const want = this.sharing && wantShareAudio({ choice: this.audioChoice, videoMode: this.videoMode.on, askedAtStart: this.audioAskedAtStart, excludesOwnOutput: false });
        const have = !!this.screenAudio || !!this.pendingAudio;
        if (want === have) break;
        if (want) {
          await this.publishSystemAudio(this.captureSystemAudio());
          if (!this.screenAudio) break; // could not capture: notice is set, do not loop
          this.notice = SHARE_AUDIO_ECHO_WARNING;
        } else {
          const audio = this.screenAudio;
          this.screenAudio = null;
          if (audio) await this.stopPublished(audio);
          if (this.pendingAudio) {
            const pending = this.pendingAudio;
            this.pendingAudio = null;
            void this.discardAudio(pending);
          }
        }
      }
    } finally {
      this.audioSyncing = false;
      this.emit();
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
    void this.pollState();
  }

  private kickChat(): void {
    void this.pollChat();
  }

  private async loops(gen: number): Promise<void> {
    const state = async () => {
      while (this.gen === gen) {
        await this.pollState();
        await sleep(statePollMs({ role: 'teacher', hidden: document.hidden, pushLive: this.pushLive }));
      }
    };
    const chat = async () => {
      while (this.gen === gen) {
        await this.pollChat();
        await sleep(chatPollMs({ hidden: document.hidden && !this.sharing, pushLive: this.pushLive }));
      }
    };
    void state();
    void chat();
  }

  /** One /state request at a time; a push during it schedules exactly one follow-up. */
  private async pollState(): Promise<void> {
    if (this.stateInflight) {
      this.stateAgain = true;
      return;
    }
    this.stateInflight = true;
    try {
      await this.pollStateOnce();
    } finally {
      this.stateInflight = false;
      if (this.stateAgain) {
        this.stateAgain = false;
        void this.pollState();
      }
    }
  }

  private async pollStateOnce(): Promise<void> {
    if (!this.code || !this.room) return;
    const res = await this.roomApi('GET', '/state');
    if (!res || res.status >= 400) return;
    const snap = parseRoomState(res.data);
    if (!snap) return;
    // A student's newer device took over their seat (web deviceTakeover).
    const fresh = freshTakeovers((res.data as { takeovers?: TakeoverNotice[] })?.takeovers, this.takeoverSeen);
    if (fresh.length) {
      this.takeoverSeen = Math.max(...fresh.map((t) => t.at));
      const text = takeoverToastText(fresh[fresh.length - 1]!);
      this.notice = text;
      // B6: a toast, not a banner: clear it after a few seconds unless something replaced it.
      window.setTimeout(() => {
        if (this.notice === text) {
          this.notice = '';
          this.emit();
        }
      }, TAKEOVER_NOTICE_MS);
    }
    if (snap.ended) {
      this.markEnded();
      return;
    }
    this.snap = snap;
    if (snap.classSessionId) this.classSessionId = snap.classSessionId;
    this.drawAllowPushes.clear();
    this.noteDrawRequests(snap);
    if (!this.clearedStaleStage && snap.stageMode === 'screen' && !this.sharing) {
      this.clearedStaleStage = true;
      void this.roomApi('POST', '/stage', { mode: 'idle' });
    }
    this.noteAttention();
    this.emit();
  }

  private async pollChat(): Promise<void> {
    if (!this.code || !this.room) return;
    const res = await this.roomApi('GET', chatPollSuffix(this.messages));
    if (!res || res.status >= 400) return;
    const list = res.data && typeof res.data === 'object' && Array.isArray((res.data as { messages?: unknown }).messages)
      ? ((res.data as { messages: ChatMessage[] }).messages)
      : [];
    this.messages = mergeMessages(this.messages, list).slice(-500);
    this.noteAttention();
    this.emit();
  }

  /** Like the web: "X asks to draw on your screen. Allow in the roster." */
  private noteDrawRequests(snap: RoomSnapshot): void {
    const now = new Set(snap.admitted.filter((p) => p.drawRequested).map((p) => p.id));
    for (const p of snap.admitted) {
      if (!p.drawRequested || this.prevDrawRequests.has(p.id)) continue;
      this.notice = `${p.displayName} asks to draw on your screen. Allow in People.`;
      desktop().notify('Asks to draw', `${p.displayName} asks to draw on your screen`);
    }
    if (!now.size && this.notice.includes(' asks to draw on your screen.')) this.notice = '';
    this.prevDrawRequests = now;
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

  private async admit(body: { participantIds: string[] } | { all: true }): Promise<void> {
    const res = await this.roomApi('POST', '/admit', body);
    const full = res ? admitFailureNotice(res.status, res.data) : null;
    if (full) {
      this.notice = full;
      this.emit();
    }
    await this.pollState();
  }

  /** One spotlighted student (their camera goes to the class); null stops it. */
  private async setSpotlight(participantId: string | null): Promise<void> {
    const res = await this.roomApi('POST', '/spotlight', { participantId });
    if (res && res.status >= 400) {
      this.notice = errorText(res.data, 'Could not change spotlight');
      this.emit();
    }
    await this.pollState();
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

  /** What the floating panels and the class window's roster / chat render. */
  panelSnapshot(): PanelSnapshot {
    const students = (this.snap?.admitted ?? []).filter((p) => p.role === 'STUDENT');
    const oldest = oldestWaiting(this.snap?.waiting ?? []);
    return {
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
        whiteboardOn: !!this.whiteboard,
        waitingRoomOn: this.snap ? this.snap.waitingRoomOn : true,
        layout: this.opts.layout,
        classLabel: this.snap?.classLabel || this.code,
        waitingCount: this.snap?.waiting.length ?? 0,
        hands: students.filter((s) => s.handRaised).length,
        focusAlerts: countFocusAlerts(students),
        unread: unreadCount(this.messages, this.lastRead, this.snap?.meId ?? null),
        oldestWaitingId: oldest?.id ?? null,
        oldestWaitingName: oldest?.displayName ?? null,
        videoMode: this.videoMode.on,
        videoModeAuto: this.videoMode.auto,
        lowPower: this.lowPower,
        shareAudio: this.viaSidecar ? this.sidecarAudio : !!this.screenAudio,
        shareAudioAuto: this.audioChoice === 'auto',
        drawRequests: this.snap?.drawRequestCount ?? 0,
        drawHolderName: drawHolderNames(this.snap),
        drawStrokes: this.drawStrokes.length,
        notice: this.notice,
      },
      admitted: this.snap?.admitted ?? [],
      waiting: this.snap?.waiting ?? [],
      messages: this.messages.slice(-100),
      chatTo: this.chatTo,
      meId: this.snap?.meId ?? null,
      devices: this.devices,
      micId: this.opts.micId,
      camId: this.opts.camId,
      spotlight: this.snap?.spotlight ?? null,
      micQueue: this.snap && this.snap.micLimit > 0 ? this.snap.micQueue : [],
      voice: this.voiceSnapshot(),
    };
  }

  private pushHud(): void {
    const snap = this.panelSnapshot();
    // Same snapshot as last time: skip the IPC fan-out to every panel.
    const key = JSON.stringify(snap);
    if (key === this.lastHud) return;
    this.lastHud = key;
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

/** Backup capture: Chromium desktop capture of the chosen source (no user gesture needed in Electron). */
async function chromiumDesktopTrack(sourceId: string): Promise<MediaStreamTrack | null> {
  if (!sourceId) return null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 },
      } as unknown as MediaTrackConstraints,
    });
    return stream.getVideoTracks()[0] ?? null;
  } catch (err) {
    console.warn('backup capture failed', err);
    return null;
  }
}

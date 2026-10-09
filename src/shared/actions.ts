/**
 * Messages between the class engine, the toolbar, and the floating panels.
 * Structured-cloneable: no tracks, no functions.
 */

import type { AdmittedPerson, ChatMessage, WaitingPerson } from './apiModel';
import type { CaptureMode, ShareKind } from './capture';
import type { SlotCount } from './classLogic';

export type { ShareKind };

export type HudState = {
  inClass: boolean;
  sharing: boolean;
  shareKind: ShareKind | null;
  captureMode: CaptureMode;
  /** Phrase a tester can read off the toolbar, for example the WGC or mask path. */
  captureLabel: string;
  captureDetail: string;
  micOn: boolean;
  camOn: boolean;
  annotateOn: boolean;
  videosOn: boolean;
  waitingRoomOn: boolean;
  layout: SlotCount;
  classLabel: string;
  waitingCount: number;
  hands: number;
  focusAlerts: number;
  unread: number;
  oldestWaitingId: string | null;
  oldestWaitingName: string | null;
  /** Share Video mode (30 fps, motion) and whether it still follows auto-detect. */
  videoMode: boolean;
  videoModeAuto: boolean;
  /** Students asking to draw on the share, the one drawing now, and strokes on screen. */
  drawRequests: number;
  drawHolderName: string | null;
  drawStrokes: number;
  /** Latest one-line notice from the class (errors, auto video mode, draw requests). */
  notice: string;
};

export type DeviceInfo = { id: string; label: string; kind: 'audioinput' | 'videoinput' };

export type PanelSnapshot = {
  hud: HudState;
  admitted: AdmittedPerson[];
  waiting: WaitingPerson[];
  messages: ChatMessage[];
  chatTo: string;
  meId: string | null;
  devices: DeviceInfo[];
  micId: string;
  camId: string;
};

export type TeacherAction =
  | { type: 'toggle-mic' }
  | { type: 'toggle-cam' }
  | { type: 'stop-share' }
  | { type: 'toggle-annotate' }
  | { type: 'toggle-videos' }
  | { type: 'toggle-video-mode' }
  | { type: 'draw-allow'; id: string }
  | { type: 'draw-revoke'; id?: string }
  | { type: 'draw-clear' }
  | { type: 'admit'; id: string }
  | { type: 'admit-all' }
  | { type: 'waiting-room'; on: boolean }
  | { type: 'mute-all'; muted: boolean }
  | { type: 'mute-one'; id: string; muted: boolean }
  | { type: 'pin'; id: string; pinned: boolean }
  | { type: 'lower-hand'; id: string }
  | { type: 'layout'; slots: SlotCount }
  | { type: 'send-chat'; text: string; to: string }
  | { type: 'chat-to'; to: string }
  | { type: 'mark-chat-read' }
  | { type: 'set-mic'; deviceId: string }
  | { type: 'set-cam'; deviceId: string }
  | { type: 'leave' }
  | { type: 'end' }
  | { type: 'show-main' }
  | { type: 'open-share' }
  | { type: 'start-share'; kind: ShareKind; sourceId: string; displayId?: string; region?: { x: number; y: number; w: number; h: number }; systemAudio?: boolean };

export function isSlot(n: unknown): n is SlotCount {
  return n === 2 || n === 4 || n === 6;
}

export function isTeacherAction(v: unknown): v is TeacherAction {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  switch (a.type) {
    case 'toggle-mic':
    case 'toggle-cam':
    case 'stop-share':
    case 'toggle-annotate':
    case 'toggle-videos':
    case 'toggle-video-mode':
    case 'draw-clear':
    case 'admit-all':
    case 'mark-chat-read':
    case 'leave':
    case 'end':
    case 'show-main':
    case 'open-share':
      return true;
    case 'admit':
    case 'lower-hand':
    case 'draw-allow':
      return typeof a.id === 'string' && a.id.length > 0;
    case 'draw-revoke':
      return a.id === undefined || (typeof a.id === 'string' && a.id.length > 0);
    case 'set-mic':
    case 'set-cam':
      return typeof a.deviceId === 'string';
    case 'waiting-room':
      return typeof a.on === 'boolean';
    case 'mute-all':
      return typeof a.muted === 'boolean';
    case 'mute-one':
      return typeof a.id === 'string' && typeof a.muted === 'boolean';
    case 'pin':
      return typeof a.id === 'string' && typeof a.pinned === 'boolean';
    case 'layout':
      return isSlot(a.slots);
    case 'send-chat':
      return typeof a.text === 'string' && typeof a.to === 'string';
    case 'chat-to':
      return typeof a.to === 'string';
    case 'start-share':
      return (a.kind === 'screen' || a.kind === 'window' || a.kind === 'region') && typeof a.sourceId === 'string';
    default:
      return false;
  }
}

export type ChromeBounds = {
  windows: { name: string; x: number; y: number; w: number; h: number }[];
  screens: { left: number; top: number; width: number; height: number; id: number; scaleFactor: number }[];
};

export type DisplayInfo = {
  id: number;
  scaleFactor: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type SourceInfo = {
  id: string;
  name: string;
  displayId: string;
  kind: 'screen' | 'window';
  thumbnail: string;
};

export type BootInfo = {
  server: string;
  email: string;
  hasCookie: boolean;
  me: { role: string; name: string; email: string; mustChangePassword: boolean } | null;
  reason: string | null;
  layout: SlotCount;
  hotkeys: { mic: string; camera: string; stopShare: string };
  micId: string;
  camId: string;
  capture: { mode: CaptureMode; affinity: number; mask: boolean; label: string; detail: string };
  platform: string;
};

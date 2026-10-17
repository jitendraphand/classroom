import type { BootInfo, ChromeBounds, DisplayInfo, PanelSnapshot, SourceInfo, TeacherAction } from '../shared/actions';
import type { AnnotateCommand, AnnotateStatus, DipBox, PhysicalMonitor } from '../shared/annotateOverlay';
import type { CapturePlan, WgcStartResult } from '../shared/capture';
import type { CaptureScenarioReport } from '../shared/captureScenario';

export type StudentInk = {
  strokes: { id: string; by: string; name: string; color: string; pts: number[] }[];
  rect: { x: number; y: number; w: number; h: number };
};

export type LoginResult = {
  ok: boolean;
  error?: string;
  mustChangePassword?: boolean;
  name?: string;
  email?: string;
};

export type AffinityRow = {
  name: string;
  hwnd: string;
  /** Electron isContentProtected(). True for every opaque classroom window. */
  protected: boolean;
  ok: boolean;
  /** False when this window must stay out of the capture. */
  captured: boolean;
};

export type CaptureDiag = {
  label: string;
  detail: string;
  logPath: string;
  windows: AffinityRow[];
};

export type CaptureDiffResult = {
  pass: boolean;
  ratio: number;
  compared: number;
  changed: number;
  note: string;
};

export type CaptureTestStart = CaptureDiag & { ok: boolean; error?: string };

export type ClassroomBridge = {
  getBoot: () => Promise<BootInfo>;
  login: (email: string, password: string) => Promise<LoginResult>;
  logout: () => Promise<{ ok: boolean }>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<{ ok: boolean; error?: string }>;
  api: (method: string, path: string, body?: unknown) => Promise<{ status: number; data: unknown }>;
  listSources: () => Promise<SourceInfo[]>;
  prepareCapture: (source: { id: string; displayId: string; name: string; kind: 'screen' | 'window' }) => Promise<boolean>;
  capturePlan: () => Promise<CapturePlan>;
  startWgc: (req: {
    kind: 'monitor' | 'window';
    sourceId: string;
    displayId: string;
    /** Native sidecar publishing (Option A); omitted = Electron publishes. */
    sidecar?: import('../shared/sidecar').SidecarRequest;
  }) => Promise<WgcStartResult>;
  /** Video mode / share sound for the native sidecar. */
  sidecarControl?: (msg: { op: 'mode'; videoMode: boolean } | { op: 'audio'; on: boolean }) => void;
  stopWgc: () => Promise<{ ok: boolean }>;
  adoptMask: (reason: string) => Promise<CapturePlan>;
  onWgcFrame: (cb: (frame: { width: number; height: number; rgba?: Uint8Array; same?: boolean }) => void) => () => void;
  onWgcEnded: (cb: (reason: string) => void) => () => void;
  onWgcStatus: (cb: (status: { state: 'recovering' | 'recovered' | 'failed'; reason: string; attempt: number }) => void) => () => void;
  annotationLayer: (layer: import('../shared/inkLayer').InkLayer) => void;
  onAnnotateLayerSize: (cb: (size: { w: number; h: number }) => void) => () => void;
  setMousePassthrough: (on: boolean) => void;
  displays: () => Promise<DisplayInfo[]>;
  pushHud: (snap: PanelSnapshot) => void;
  sendAction: (action: TeacherAction) => void;
  onAction: (cb: (action: TeacherAction) => void) => () => void;
  onHud: (cb: (snap: PanelSnapshot) => void) => () => void;
  resizeToolbar: (w: number, h: number) => void;
  togglePanel: (kind: 'chat' | 'roster' | 'devices') => void;
  minimizeMain: () => void;
  restoreMain: () => void;
  notify: (title: string, body: string) => void;
  confirmEnd: () => Promise<boolean>;
  onChromeBounds: (cb: (bounds: ChromeBounds) => void) => () => void;
  saveHotkeys: (hotkeys: BootInfo['hotkeys']) => Promise<{ ok: boolean; error?: string }>;
  saveLayout: (slots: number) => Promise<void>;
  saveDevices: (micId: string, camId: string) => Promise<void>;
  setServer: (url: string) => Promise<{ ok: boolean; server?: string; error?: string }>;
  setClassActive: (on: boolean) => void;
  captureTestOpen: () => Promise<{ ok: boolean }>;
  captureTestStart: () => Promise<CaptureTestStart>;
  captureTestStop: () => Promise<{ ok: boolean }>;
  captureDiagnostics: () => Promise<CaptureDiag>;
  captureDiff: () => Promise<CaptureDiffResult>;
  captureScenario: () => Promise<CaptureScenarioReport>;
  annotationOpen: (displayId: string) => Promise<{ ok: boolean }>;
  annotationClose: () => Promise<{ ok: boolean }>;
  annotationActive: (on: boolean) => void;
  annotationCommand: (cmd: AnnotateCommand) => void;
  annotationStatus: (status: AnnotateStatus) => void;
  annotationInk: (shapes: unknown) => void;
  /** Student ink for the desktop overlay (normalised to the shared picture, mapped by `rect`). */
  studentInk: (ink: StudentInk) => void;
  onStudentInk: (cb: (ink: StudentInk) => void) => () => void;
  /** Main window / Student videos window shown (visible and not minimized). */
  onPanelWindows: (cb: (state: { main: boolean; videos: boolean }) => void) => () => void;
  /** Overlay eraser hit these student strokes: delete them for everyone. */
  eraseStudentInk: (ids: string[]) => void;
  /** Tools panel: clear every student drawing. */
  clearStudentInk: () => void;
  /** Class window: the teacher erased / cleared student ink from the overlay or tools. */
  onStudentInkEdit: (cb: (edit: { erase?: string[]; clear?: boolean }) => void) => () => void;
  /** Restart the WGC helper at this capture rate (video mode). */
  setWgcFps: (fps: number) => Promise<{ ok: boolean }>;
  /** Annotation panel: draw on the overlay (true) or let clicks through (false). */
  annotationDrawMode: (on: boolean) => void;
  /** Annotate toolbar dock: resize its window (horizontal bar / vertical strip). */
  annotateToolsOrient?: (orient: 'horizontal' | 'vertical') => void;
  /** Tools panel content size (one line) or "still overflowing", for main to fit the window. */
  annotateToolsMeasure?: (m: { width: number; height: number; overflow: boolean }) => void;
  /** Share toolbar flyout: room needed across the bar (0 = closed) and along it. */
  annotateToolsFlyout?: (m: { size: number; along: number }) => void;
  /** Sidecar share audio: process loopback (excluding this app) started, or unavailable. */
  /** Computer-sound level from the sidecar (dBFS, 10x/s while it is sent). */
  onSidecarAudioLevel?: (cb: (db: unknown) => void) => () => void;
  /** Adaptive capture level for the share toolbar indicator. */
  onAdaptiveStatus?: (cb: (st: unknown) => void) => () => void;
  onSidecarAudio?: (cb: (m: unknown) => void) => () => void;
  onToolsFlyoutSide?: (cb: (side: unknown) => void) => () => void;
  postVideoTile: (key: string, jpeg: Uint8Array) => void;
  onVideoTile: (cb: (key: string, jpeg: ArrayBuffer | Uint8Array) => void) => () => void;
  onAnnotateSurface: (cb: (surface: { dip: DipBox; physical: PhysicalMonitor; scale: number }) => void) => () => void;
  onAnnotateMode: (cb: (on: boolean) => void) => () => void;
  onAnnotateCommand: (cb: (cmd: AnnotateCommand) => void) => () => void;
  onAnnotateStatus: (cb: (status: AnnotateStatus) => void) => () => void;
};

declare global {
  interface Window {
    classroom: ClassroomBridge;
  }
}

export function desktop(): ClassroomBridge {
  return window.classroom;
}

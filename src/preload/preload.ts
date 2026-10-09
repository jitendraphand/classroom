import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

function listen(channel: string, cb: (payload: unknown) => void): () => void {
  const fn = (_event: IpcRendererEvent, payload: unknown) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
}

contextBridge.exposeInMainWorld('classroom', {
  getBoot: () => ipcRenderer.invoke('boot'),
  login: (email: string, password: string) => ipcRenderer.invoke('login', email, password),
  logout: () => ipcRenderer.invoke('logout'),
  changePassword: (currentPassword: string, newPassword: string) =>
    ipcRenderer.invoke('change-password', currentPassword, newPassword),
  api: (method: string, path: string, body?: unknown) => ipcRenderer.invoke('api', method, path, body),
  listSources: () => ipcRenderer.invoke('list-sources'),
  prepareCapture: (source: unknown) => ipcRenderer.invoke('prepare-capture', source),
  capturePlan: () => ipcRenderer.invoke('capture-plan'),
  startWgc: (req: unknown) => ipcRenderer.invoke('start-wgc', req),
  stopWgc: () => ipcRenderer.invoke('stop-wgc'),
  adoptMask: (reason: string) => ipcRenderer.invoke('adopt-mask', reason),
  onWgcFrame: (cb: (frame: unknown) => void) => listen('wgc-frame', cb),
  onWgcEnded: (cb: () => void) => listen('wgc-ended', () => cb()),
  setMousePassthrough: (on: boolean) => ipcRenderer.send('mouse-passthrough', on),
  displays: () => ipcRenderer.invoke('displays'),
  pushHud: (snap: unknown) => ipcRenderer.send('push-hud', snap),
  sendAction: (action: unknown) => ipcRenderer.send('action', action),
  onAction: (cb: (action: unknown) => void) => listen('action', cb),
  onHud: (cb: (snap: unknown) => void) => listen('hud-state', cb),
  resizeToolbar: (w: number, h: number) => ipcRenderer.send('toolbar-size', w, h),
  togglePanel: (kind: string) => ipcRenderer.send('toggle-panel', kind),
  minimizeMain: () => ipcRenderer.send('minimize-main'),
  restoreMain: () => ipcRenderer.send('restore-main'),
  notify: (title: string, body: string) => ipcRenderer.send('notify', title, body),
  confirmEnd: () => ipcRenderer.invoke('confirm-end'),
  onChromeBounds: (cb: (bounds: unknown) => void) => listen('chrome-bounds', cb),
  saveHotkeys: (hotkeys: unknown) => ipcRenderer.invoke('save-hotkeys', hotkeys),
  saveLayout: (slots: unknown) => ipcRenderer.invoke('save-layout', slots),
  saveDevices: (micId: string, camId: string) => ipcRenderer.invoke('save-devices', micId, camId),
  setServer: (url: string) => ipcRenderer.invoke('set-server', url),
  setClassActive: (on: boolean) => ipcRenderer.send('class-active', on),
  captureTestOpen: () => ipcRenderer.invoke('capture-test-open'),
  captureTestStart: () => ipcRenderer.invoke('capture-test-start'),
  captureTestStop: () => ipcRenderer.invoke('capture-test-stop'),
  captureDiagnostics: () => ipcRenderer.invoke('capture-diagnostics'),
  captureDiff: () => ipcRenderer.invoke('capture-diff'),
  captureScenario: () => ipcRenderer.invoke('capture-scenario'),
  annotationOpen: (displayId: string) => ipcRenderer.invoke('annotation-open', displayId),
  annotationClose: () => ipcRenderer.invoke('annotation-close'),
  annotationActive: (on: boolean) => ipcRenderer.send('annotation-active', on),
  annotationCommand: (cmd: unknown) => ipcRenderer.send('annotation-command', cmd),
  annotationStatus: (status: unknown) => ipcRenderer.send('annotation-status', status),
  annotationInk: (shapes: unknown) => ipcRenderer.send('annotation-ink', shapes),
  studentInk: (ink: unknown) => ipcRenderer.send('student-ink', ink),
  onStudentInk: (cb: (ink: unknown) => void) => listen('student-ink', cb),
  setWgcFps: (fps: number) => ipcRenderer.invoke('wgc-fps', fps),
  annotationDrawMode: (on: boolean) => ipcRenderer.send('annotation-draw-mode', on),
  postVideoTile: (key: string, jpeg: Uint8Array) => {
    const copy = jpeg.byteOffset === 0 && jpeg.byteLength === jpeg.buffer.byteLength ? jpeg : jpeg.slice();
    ipcRenderer.send('video-tile', key, copy.buffer);
  },
  onVideoTile: (cb: (key: string, jpeg: ArrayBuffer | Uint8Array) => void) => {
    const fn = (_event: IpcRendererEvent, key: unknown, jpeg: unknown) => {
      if (typeof key !== 'string') return;
      if (jpeg instanceof ArrayBuffer || jpeg instanceof Uint8Array) cb(key, jpeg);
    };
    ipcRenderer.on('video-tile', fn);
    return () => ipcRenderer.removeListener('video-tile', fn);
  },
  onAnnotateSurface: (cb: (surface: unknown) => void) => listen('annotate-surface', cb),
  onAnnotateMode: (cb: (on: unknown) => void) => listen('annotate-mode', (on) => cb(on === true)),
  onAnnotateCommand: (cb: (cmd: unknown) => void) => listen('annotate-command', cb),
  onAnnotateStatus: (cb: (status: unknown) => void) => listen('annotate-status', cb),
});

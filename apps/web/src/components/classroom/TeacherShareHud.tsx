'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from '@/components/ui/Avatar';
import {
  ANNOTATE_COLORS,
  useScreenAnnotate,
  type AnnotateMode,
} from './ScreenAnnotator';
import { IconChat, IconHand, IconMic, IconMicOff, IconScreen, IconUsers } from '@/components/ui/Icons';
import { useFloatDrag, type FloatPos } from './FloatingPanel';

/**
 * Teacher share controls.
 *
 * Window or tab capture: the controls float in a separate always-on-top window
 * (Document Picture-in-Picture where the browser has it, otherwise a
 * same-origin popup). That window is not part of the captured surface, so
 * students never see it.
 *
 * Entire-screen ("monitor") capture records every window on that screen,
 * including an always-on-top PiP window and the popup; no getDisplayMedia hint
 * or Region Capture can exclude another window from a monitor capture. So in
 * that case the floating window is closed before the track is published and
 * the same controls render inline in the classroom tab instead
 * (`InlineShareDock`). Students only see them if the teacher puts the
 * classroom tab itself on the shared screen.
 */

export type RosterEntry = {
  id: string;
  displayName: string;
  role: string;
  mutedByTeacher?: boolean;
  isVisible?: boolean;
  handRaised?: boolean;
};

export type TeacherShareHudProps = {
  /** Mount node that lives in the control window, not in the classroom page. */
  host: HTMLElement | null;
  hostWindow: Window | null;
  admitted: RosterEntry[];
  waiting?: RosterEntry[];
  waitingCount?: number;
  onAdmit?: (participantId: string) => void;
  onAdmitAll?: () => void;
  teacherMicOn: boolean;
  onToggleTeacherMic: () => void;
  onStopSharing: () => void;
  onMuteStudent: (participantId: string, muted: boolean) => void;
  onMuteAll: (muted: boolean) => void;
  onLowerHand: (participantId: string) => void;
  chatUnread: number;
  chat?: ReactNode;
  onChatOpenChange?: (open: boolean) => void;
  annotate: ReturnType<typeof useScreenAnnotate>;
  annotateOn: boolean;
  onAnnotateOnChange: (on: boolean) => void;
  annotateMode: AnnotateMode;
  onAnnotateModeChange: (mode: AnnotateMode) => void;
  annotateColor: string;
  onAnnotateColorChange: (color: string) => void;
  notice?: string;
  /** Render in the classroom page (monitor capture / no pop-out) instead of a portal. */
  inline?: boolean;
};

type Panel = 'chat' | 'hands' | 'roster' | null;

const TOOL_LABEL: Record<AnnotateMode, string> = {
  pen: 'Pen',
  highlighter: 'Marker',
  eraser: 'Erase',
};

const POPUP_FEATURES =
  'popup=yes,width=860,height=72,menubar=no,toolbar=no,location=no,status=no,resizable=yes';

type PictureInPictureApi = {
  requestWindow: (opts: { width: number; height: number }) => Promise<Window>;
};

export type ShareControlSurface = {
  /**
   * `pip`: Document Picture-in-Picture (Chromium). `popup`: a normal window,
   * which IS captured when the teacher shares the entire screen.
   */
  kind: 'pip' | 'popup';
  window: Window;
  mount: HTMLElement;
  close: () => void;
};

let preparedWindow: Window | null = null;

function pictureInPictureApi(): PictureInPictureApi | null {
  if (typeof window === 'undefined' || !window.isSecureContext) return null;
  const api = (window as Window & { documentPictureInPicture?: PictureInPictureApi })
    .documentPictureInPicture;
  if (!api || typeof api.requestWindow !== 'function') return null;
  return api;
}

export function supportsDocumentPip(): boolean {
  return pictureInPictureApi() !== null;
}

function controlUrl(): string {
  // Static file, not the Next /hud route: that route boots the app layout,
  // including idle logout, which would sign the teacher out from the popup.
  return `${window.location.origin}/share-controls.html`;
}

/** Open the popup on pointer-down so Firefox and Safari still have a gesture for getDisplayMedia on click. */
export function preopenShareControls() {
  if (typeof window === 'undefined' || supportsDocumentPip()) return;
  if (preparedWindow && !preparedWindow.closed) return;
  const opened = window.open(controlUrl(), 'classroom-share-controls', POPUP_FEATURES);
  preparedWindow = opened;
  if (!opened) return;
  window.setTimeout(() => {
    if (preparedWindow === opened) {
      try {
        opened.close();
      } catch {
        /* ignore */
      }
      preparedWindow = null;
    }
  }, 2500);
}

function styleControlDocument(
  win: Window,
  mount: HTMLElement,
  kind: ShareControlSurface['kind']
): ShareControlSurface {
  const doc = win.document;
  doc.title = 'Share controls';
  const root = doc.documentElement;
  const body = doc.body;
  root.className = document.documentElement.className;
  body.className = document.body.className;
  root.style.background = '#0d1219';
  root.style.height = 'auto';
  body.style.margin = '0';
  body.style.minHeight = '0';
  body.style.height = 'auto';
  body.style.background = '#0d1219';
  // Bar is sticky at the top; if the window cannot grow, the panel scrolls.
  body.style.overflowX = 'hidden';
  body.style.overflowY = 'auto';
  return {
    kind,
    window: win,
    mount,
    close: () => {
      try {
        win.close();
      } catch {
        /* ignore */
      }
    },
  };
}

function copyParentStyles(win: Window) {
  const head = win.document.head;
  let base = head.querySelector('base');
  if (!base) {
    base = win.document.createElement('base');
    head.prepend(base);
  }
  base.setAttribute('href', `${window.location.origin}/`);
  head.querySelectorAll('[data-share-style="1"]').forEach((node) => node.remove());
  document.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => {
    const copy = node.cloneNode(true) as HTMLElement;
    copy.setAttribute('data-share-style', '1');
    head.appendChild(copy);
  });
}

function mountIn(win: Window): HTMLElement {
  const doc = win.document;
  let mount = doc.getElementById('share-controls-root');
  if (!mount) {
    mount = doc.createElement('div');
    mount.id = 'share-controls-root';
  }
  doc.body.replaceChildren(mount);
  return mount;
}

function waitForWindow(win: Window): Promise<Window | null> {
  return new Promise((resolve) => {
    const finish = () => resolve(win.closed ? null : win);
    try {
      if (win.document.readyState === 'complete') {
        finish();
        return;
      }
    } catch {
      resolve(null);
      return;
    }
    const timer = window.setTimeout(finish, 4000);
    win.addEventListener(
      'load',
      () => {
        window.clearTimeout(timer);
        finish();
      },
      { once: true }
    );
  });
}

function openPopupSurface(): Promise<ShareControlSurface | null> {
  const existing = preparedWindow && !preparedWindow.closed ? preparedWindow : null;
  preparedWindow = null;
  const win = existing ?? window.open(controlUrl(), 'classroom-share-controls', POPUP_FEATURES);
  if (!win) return Promise.resolve(null);
  return waitForWindow(win).then((ready) => {
    if (!ready || ready.closed) return null;
    try {
      copyParentStyles(ready);
      return styleControlDocument(ready, mountIn(ready), 'popup');
    } catch {
      return null;
    }
  });
}

/**
 * Call synchronously inside the share click, before any await, so the browser
 * still counts it as a user gesture. Chromium opens Document Picture-in-Picture.
 * Other browsers reuse the popup opened on pointer-down, or open one now.
 */
export function beginShareControls(): Promise<ShareControlSurface | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  const pip = pictureInPictureApi();
  if (pip) {
    let request: Promise<Window>;
    try {
      request = pip.requestWindow({ width: 860, height: 64 });
    } catch {
      return openPopupSurface();
    }
    return request
      .then((win) => {
        copyParentStyles(win);
        return styleControlDocument(win, mountIn(win), 'pip');
      })
      .catch(() => openPopupSurface());
  }
  return openPopupSurface();
}

const HUD_CSS = `
.tsh{--bg:#0d1219;--line:rgba(255,255,255,.12);--text:#eef2ff;--dim:#94a3b8;--accent:#3385ff;--warn:#f59e0b;
display:block;width:max-content;margin:0;background:#0d1219;color:var(--text);
font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:12px;line-height:1.2}
.tsh *{box-sizing:border-box}
.tsh-bar{display:flex;align-items:center;gap:3px;flex-wrap:nowrap;width:max-content;min-width:100%;
padding:4px 6px;overflow-x:auto;background:#0d1219;position:sticky;top:0;z-index:2}
.tsh-panel{width:min(420px,100vw);max-height:280px;border-bottom:0;display:flex;flex-direction:column;border-top:1px solid var(--line);background:#0d1219}
.tsh-tip{padding:4px 8px;font-size:11px;color:#fde68a;background:rgba(245,158,11,.16);white-space:nowrap}
.tsh-live{font-size:8px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:2px 6px;border-radius:999px;
color:#bbf7d0;border:1px solid rgba(34,197,94,.4);background:rgba(34,197,94,.14);white-space:nowrap}
.tsh-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.tsh-btn{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:4px;
height:28px;padding:0 7px;border-radius:8px;border:1px solid transparent;color:var(--text);
font-size:11px;font-weight:650;white-space:nowrap;position:relative;flex:0 0 auto}
.tsh-btn:hover{background:rgba(255,255,255,.1)}
.tsh-btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.tsh-btn[aria-pressed="true"]{background:rgba(51,133,255,.28);border-color:rgba(51,133,255,.55)}
.tsh-btn-danger{color:#fecaca}
.tsh-btn-danger:hover{background:rgba(239,68,68,.28);border-color:rgba(239,68,68,.5)}
.tsh-btn[disabled]{opacity:.4;cursor:default}
.tsh-sep{width:1px;height:18px;background:var(--line);flex:0 0 auto}
.tsh-count{position:absolute;top:-4px;right:-4px;min-width:14px;height:14px;padding:0 3px;border-radius:999px;
background:var(--warn);color:#1a1206;font-size:9px;font-weight:800;display:inline-grid;place-items:center}
.tsh-count-blue{background:var(--accent);color:#04122b}
.tsh-swatch{all:unset;box-sizing:border-box;cursor:pointer;width:14px;height:14px;border-radius:999px;border:2px solid transparent;flex:0 0 auto}
.tsh-swatch[aria-pressed="true"]{border-color:#fff}
.tsh-panel-head{display:flex;align-items:center;gap:6px;padding:4px 8px;border-bottom:1px solid var(--line)}
.tsh-panel-title{font-weight:650;font-size:11px;flex:1}
.tsh-scroll{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 8px}
.tsh-empty{color:var(--dim);font-size:11px;text-align:center;padding:12px 8px;margin:0}
.tsh-person{display:flex;align-items:center;gap:6px;padding:5px;border-radius:8px;background:rgba(255,255,255,.04);margin-bottom:4px}
.tsh-person-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:11px}
.tsh-person-sub{font-size:10px;color:var(--dim);font-weight:500}
.tsh-chip{font-size:9px;font-weight:700;padding:1px 4px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
.tsh-chip-muted{color:#fcd34d;border-color:rgba(245,158,11,.4)}
.tsh-chat{height:220px;min-height:160px}
.tsh-admit{max-width:140px;overflow:hidden;text-overflow:ellipsis}
.tsh-inline{width:auto;max-width:calc(100vw - 16px)}
.tsh-inline .tsh-bar{flex-wrap:wrap;width:auto;min-width:0;position:static}
.tsh-inline .tsh-panel{width:min(420px,calc(100vw - 16px));max-height:min(280px,45vh)}
.tsh-inline .tsh-chat{height:min(220px,35vh)}
`;

export function TeacherShareHud(props: TeacherShareHudProps) {
  const {
    host,
    hostWindow,
    admitted,
    waiting = [],
    waitingCount = 0,
    onAdmit,
    onAdmitAll,
    teacherMicOn,
    onToggleTeacherMic,
    onStopSharing,
    onMuteStudent,
    onMuteAll,
    onLowerHand,
    chatUnread,
    chat,
    onChatOpenChange,
    annotate,
    annotateOn,
    onAnnotateOnChange,
    annotateMode: mode,
    onAnnotateModeChange: setMode,
    annotateColor: color,
    onAnnotateColorChange: setColor,
    notice,
    inline = false,
  } = props;

  const [panel, setPanel] = useState<Panel>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // A new waiting student does NOT open the roster by itself. Document PiP and
  // pop-ups refuse resizeTo() without a user gesture, so an auto-opened panel
  // could not grow the window. The bar already shows a waiting badge and an
  // "Admit <name>" button; the teacher opens the roster with a click.

  useEffect(() => {
    onChatOpenChange?.(panel === 'chat');
  }, [panel, onChatOpenChange]);

  useEffect(() => {
    return () => onChatOpenChange?.(false);
  }, [onChatOpenChange]);

  useEffect(() => {
    const win = hostWindow;
    const root = rootRef.current;
    if (!win || !root || win.closed) return;
    const fit = () => {
      if (win.closed) return;
      const bar = root.querySelector('.tsh-bar') as HTMLElement | null;
      let barW = 0;
      if (bar) {
        const styles = win.getComputedStyle(bar);
        const gap = parseFloat(styles.columnGap || styles.gap || '0') || 0;
        const kids = Array.from(bar.children) as HTMLElement[];
        barW = kids.reduce((sum, el, i) => sum + el.offsetWidth + (i ? gap : 0), 0);
        barW += (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
      }
      const contentW = Math.max(barW, root.scrollWidth);
      const contentH = root.scrollHeight;
      const width = Math.ceil(Math.min(980, Math.max(520, contentW + 8)));
      const height = Math.ceil(Math.min(460, Math.max(48, contentH + 8)));
      if (bar) bar.style.maxWidth = contentW + 8 > 980 ? '972px' : '';
      const extraW = win.innerWidth > 0 ? Math.max(0, win.outerWidth - win.innerWidth) : 0;
      const extraH = win.innerHeight > 0 ? Math.max(0, win.outerHeight - win.innerHeight) : 0;
      try {
        win.resizeTo(width + extraW, height + extraH);
      } catch {
        /* some browsers refuse resize */
      }
    };
    fit();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    ro?.observe(root);
    return () => ro?.disconnect();
  }, [hostWindow, panel, annotateOn, waitingCount, notice, mode]);

  const students = useMemo(() => admitted.filter((a) => a.role === 'STUDENT'), [admitted]);
  const hands = useMemo(() => students.filter((s) => s.handRaised), [students]);

  const togglePanel = (next: Exclude<Panel, null>) => {
    setPanel((cur) => (cur === next ? null : next));
  };

  if (!host && !inline) return null;

  const waitingLabel =
    waitingCount === 1
      ? `${waiting[0]?.displayName || 'A student'} is waiting`
      : waitingCount > 1
        ? `${waitingCount} students are waiting`
        : '';

  const tree = (
    <div ref={rootRef} className={inline ? 'tsh tsh-inline' : 'tsh'} role="region" aria-label="Share controls">
      <style>{HUD_CSS}</style>
      <div className="tsh-sr" aria-live="polite">
        {waitingLabel}
      </div>
      <div className="tsh-bar" role="toolbar" aria-label="Share tools">
        <span className="tsh-live">Live</span>
        <button
          type="button"
          className="tsh-btn"
          aria-pressed={!teacherMicOn}
          onClick={onToggleTeacherMic}
          aria-label={teacherMicOn ? 'Mute mic' : 'Unmute mic'}
          title={teacherMicOn ? 'Mute mic' : 'Unmute mic'}
        >
          {teacherMicOn ? <IconMic size={14} /> : <IconMicOff size={14} />}
        </button>
        <button
          type="button"
          className="tsh-btn"
          aria-pressed={annotateOn}
          onClick={() => onAnnotateOnChange(!annotateOn)}
          title="Draw on the shared screen"
        >
          Annotate
        </button>
        {annotateOn &&
          (['pen', 'highlighter', 'eraser'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className="tsh-btn"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
            >
              {TOOL_LABEL[m]}
            </button>
          ))}
        {annotateOn &&
          ANNOTATE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className="tsh-swatch"
              style={{ background: c }}
              aria-label={`Colour ${c}`}
              aria-pressed={color === c}
              onClick={() => setColor(c)}
            />
          ))}
        {annotateOn && (
          <button
            type="button"
            className="tsh-btn"
            onClick={annotate.undo}
            disabled={!annotate.strokes.length}
            title="Undo your last stroke"
          >
            Undo
          </button>
        )}
        {annotateOn && (
          <button
            type="button"
            className="tsh-btn"
            onClick={annotate.clear}
            disabled={!annotate.strokes.length}
            title="Clear all drawings for everyone"
          >
            Clear
          </button>
        )}
        <span className="tsh-sep" aria-hidden />
        <button
          type="button"
          className="tsh-btn"
          aria-pressed={panel === 'chat'}
          onClick={() => togglePanel('chat')}
          aria-label="Chat"
          title="Chat"
        >
          <IconChat size={14} />
          {chatUnread > 0 && panel !== 'chat' && (
            <span className="tsh-count">{chatUnread > 9 ? '9+' : chatUnread}</span>
          )}
        </button>
        <button
          type="button"
          className="tsh-btn"
          aria-pressed={panel === 'hands'}
          onClick={() => togglePanel('hands')}
          aria-label="Raised hands"
          title="Raised hands"
        >
          <IconHand size={14} />
          {hands.length > 0 && panel !== 'hands' && <span className="tsh-count">{hands.length}</span>}
        </button>
        <button
          type="button"
          className="tsh-btn"
          aria-pressed={panel === 'roster'}
          onClick={() => togglePanel('roster')}
          aria-label="Roster"
          title="Roster"
        >
          <IconUsers size={14} />
          {waitingCount > 0 && panel !== 'roster' ? (
            <span className="tsh-count">{waitingCount > 9 ? '9+' : waitingCount}</span>
          ) : students.length > 0 && panel !== 'roster' ? (
            <span className="tsh-count tsh-count-blue">{students.length}</span>
          ) : null}
        </button>
        {waiting.length > 0 && (
          <button
            type="button"
            className="tsh-btn"
            onClick={() => onAdmit?.(waiting[0].id)}
            title={`Admit ${waiting[0].displayName}`}
          >
            <span className="tsh-admit">Admit {waiting[0].displayName}</span>
          </button>
        )}
        {waiting.length > 1 && (
          <button type="button" className="tsh-btn" onClick={() => onAdmitAll?.()}>
            Admit all
          </button>
        )}
        <span className="tsh-sep" aria-hidden />
        <button type="button" className="tsh-btn tsh-btn-danger" onClick={onStopSharing} title="Stop sharing">
          <IconScreen size={14} />
          Stop
        </button>
      </div>
      {notice ? <div className="tsh-tip">{notice}</div> : null}

      {panel === 'chat' && (
        <div className="tsh-panel">
          <div className="tsh-panel-head">
            <span className="tsh-panel-title">Chat</span>
            <button type="button" className="tsh-btn" onClick={() => setPanel(null)} aria-label="Close chat">
              Close
            </button>
          </div>
          <div className="tsh-chat">{chat}</div>
        </div>
      )}

      {panel === 'hands' && (
        <div className="tsh-panel">
          <div className="tsh-panel-head">
            <span className="tsh-panel-title">Raised hands</span>
            <button type="button" className="tsh-btn" onClick={() => setPanel(null)} aria-label="Close hands">
              Close
            </button>
          </div>
          <div className="tsh-scroll">
            {hands.length === 0 ? (
              <p className="tsh-empty">No raised hands.</p>
            ) : (
              hands.map((s) => (
                <div className="tsh-person" key={s.id}>
                  <Avatar name={s.displayName} size="sm" />
                  <span className="tsh-person-name">{s.displayName}</span>
                  <button type="button" className="tsh-btn" onClick={() => onLowerHand(s.id)}>
                    Lower
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {panel === 'roster' && (
        <div className="tsh-panel">
          <div className="tsh-panel-head">
            <span className="tsh-panel-title">Roster</span>
            {waitingCount > 0 && <span className="tsh-chip">{waitingCount} waiting</span>}
            <button type="button" className="tsh-btn" onClick={() => setPanel(null)} aria-label="Close roster">
              Close
            </button>
          </div>
          <div className="tsh-scroll">
            {waiting.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  <span className="tsh-panel-title">Waiting</span>
                  {waiting.length > 1 && (
                    <button type="button" className="tsh-btn" onClick={() => onAdmitAll?.()}>
                      Admit all
                    </button>
                  )}
                </div>
                {waiting.map((w) => (
                  <div className="tsh-person" key={w.id}>
                    <Avatar name={w.displayName} size="sm" />
                    <span className="tsh-person-name">{w.displayName}</span>
                    <button type="button" className="tsh-btn" onClick={() => onAdmit?.(w.id)}>
                      Admit
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
              <button type="button" className="tsh-btn" onClick={() => onMuteAll(true)}>
                Mute all
              </button>
              <button type="button" className="tsh-btn" onClick={() => onMuteAll(false)}>
                Unmute all
              </button>
            </div>
            {students.length === 0 ? (
              <p className="tsh-empty">No students yet.</p>
            ) : (
              students.map((s) => (
                <div className="tsh-person" key={s.id}>
                  <Avatar name={s.displayName} size="sm" />
                  <span className="tsh-person-name">
                    {s.displayName}
                    <span className="tsh-person-sub" style={{ display: 'block' }}>
                      {s.mutedByTeacher ? 'muted by you' : s.isVisible ? 'in sample' : 'local only'}
                    </span>
                  </span>
                  {s.mutedByTeacher ? <span className="tsh-chip tsh-chip-muted">muted</span> : null}
                  <button
                    type="button"
                    className="tsh-btn"
                    onClick={() => onMuteStudent(s.id, !s.mutedByTeacher)}
                  >
                    {s.mutedByTeacher ? 'Unmute' : 'Mute'}
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

    </div>
  );

  if (inline || !host) return tree;
  return createPortal(tree, host);
}

/**
 * In-page home for the share controls when no floating window may be used
 * (entire-screen capture) or none could be opened (pop-up blocked, teacher
 * closed it). Draggable by its grip, remembered across shares, and kept on
 * screen on resize / rotation.
 */
export function InlineShareDock({
  children,
  hint,
  onPopOut,
}: {
  children: ReactNode;
  hint?: string;
  /** Re-open the floating window (only offered for window/tab captures). */
  onPopOut?: () => void;
}) {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const defaultPos = useCallback(
    (): FloatPos => ({ x: Math.max(8, (window.innerWidth - 640) / 2), y: window.innerHeight - 190 }),
    []
  );
  const { pos, handleProps } = useFloatDrag({ id: 'share_controls', paneRef, defaultPos });
  return (
    <div
      ref={paneRef}
      className="share-inline-dock"
      style={pos ? { left: pos.x, top: pos.y } : { left: 8, bottom: 96 }}
      role="region"
      aria-label="Share controls (in this tab)"
    >
      <div className="share-inline-head" {...handleProps} title="Drag to move">
        <span aria-hidden className="text-slate-500">⠿</span>
        <span className="flex-1 truncate">Share controls</span>
        {onPopOut && (
          <button type="button" className="share-inline-btn" onClick={onPopOut}>
            Pop out
          </button>
        )}
      </div>
      {children}
      {hint ? <p className="share-inline-hint">{hint}</p> : null}
    </div>
  );
}

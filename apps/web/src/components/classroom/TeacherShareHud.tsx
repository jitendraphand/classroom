'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from '@/components/ui/Avatar';
import { Chat } from './Chat';
import {
  ANNOTATE_COLORS,
  useScreenAnnotate,
  type AnnotateMode,
} from './ScreenAnnotator';
import { IconChat, IconHand, IconMic, IconMicOff, IconScreen, IconUsers } from '@/components/ui/Icons';

/**
 * Teacher "Share HUD" — keep teaching while the classroom tab is covered.
 *
 * Hosts, in preference order:
 *   1. Document Picture-in-Picture (Chromium 116+). A real OS window that stays
 *      on top, so it survives the main tab being minimised or covered.
 *   2. `window.open` popup (any desktop browser). A separate window, but the
 *      platform offers no always-on-top to web content, so the teacher may have
 *      to raise it manually.
 *   3. In-page bottom sheet. The only option on mobile, and the fallback when
 *      the first two are refused.
 *
 * `open()` must be called synchronously from a user gesture: Document PiP
 * requires transient activation and popup blockers apply to `window.open`.
 *
 * All HUD chrome is styled by the inlined HUD_CSS rather than Tailwind, so the
 * same markup renders correctly in a PiP/popup document (which starts with an
 * empty <head>). Embedded children that do rely on Tailwind — Chat — get the
 * host document's stylesheets copied across on a best-effort basis.
 */

export type HudHost = 'pip' | 'popup' | 'inline';

/* ------------------------------------------------------------------ styles */

const HUD_CSS = `
.hud-root{--hud-bg:#0d1219;--hud-line:rgba(255,255,255,.10);--hud-text:#eef2ff;--hud-dim:#94a3b8;--hud-accent:#3385ff;--hud-warn:#f59e0b;
box-sizing:border-box;height:100%;display:flex;flex-direction:column;background:var(--hud-bg);color:var(--hud-text);overflow:hidden;
font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:12px;line-height:1.35}
.hud-root *{box-sizing:border-box}
.hud-head{display:flex;align-items:center;gap:4px;padding:5px 7px;border-bottom:1px solid var(--hud-line);background:rgba(0,0,0,.35);flex:0 0 auto}
.hud-title{font-weight:650;font-size:11px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hud-badge{font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:1px 4px;border-radius:999px;border:1px solid var(--hud-line);color:var(--hud-dim);white-space:nowrap}
.hud-badge-live{color:#bbf7d0;border-color:rgba(34,197,94,.4);background:rgba(34,197,94,.14)}
.hud-x{all:unset;cursor:pointer;width:26px;height:26px;min-width:26px;display:grid;place-items:center;border-radius:7px;color:var(--hud-dim);font-size:14px;line-height:1;text-align:center}
.hud-x:hover{background:rgba(255,255,255,.1);color:#fff}
.hud-x:focus-visible{outline:2px solid var(--hud-accent);outline-offset:1px}
.hud-btn{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:4px;min-height:30px;
padding:4px 8px;border-radius:8px;border:1px solid var(--hud-line);background:rgba(255,255,255,.06);color:var(--hud-text);
font-size:11px;font-weight:600;text-align:center;line-height:1.2}
.hud-btn:hover{background:rgba(255,255,255,.13)}
.hud-btn:focus-visible{outline:2px solid var(--hud-accent);outline-offset:1px}
.hud-btn[aria-pressed="true"]{background:rgba(51,133,255,.26);border-color:rgba(51,133,255,.6);color:#fff}
.hud-btn[disabled]{opacity:.45;cursor:default}
.hud-btn-danger{background:rgba(239,68,68,.2);border-color:rgba(239,68,68,.45);color:#fecaca}
.hud-btn-danger:hover{background:rgba(239,68,68,.32)}
.hud-btn-sm{min-height:26px;padding:3px 7px;font-size:10.5px}
.hud-row{display:flex;align-items:center;gap:5px;padding:5px 7px;border-bottom:1px solid var(--hud-line);flex:0 0 auto;flex-wrap:wrap}
.hud-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.hud-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:6px 7px;-webkit-overflow-scrolling:touch}
.hud-empty{color:var(--hud-dim);font-size:11px;text-align:center;padding:14px 8px;margin:0}
.hud-note{font-size:10px;line-height:1.4;color:var(--hud-dim);padding:5px 7px;border-top:1px solid var(--hud-line);background:rgba(0,0,0,.25);flex:0 0 auto;margin:0}
.hud-warn{background:rgba(245,158,11,.16);color:#fde68a;padding:5px 7px;font-size:10.5px;line-height:1.35;border-bottom:1px solid rgba(245,158,11,.3);flex:0 0 auto;margin:0}
.hud-tabs{display:flex;gap:3px;padding:4px 7px;border-bottom:1px solid var(--hud-line);flex:0 0 auto}
.hud-tab{all:unset;box-sizing:border-box;cursor:pointer;flex:1 1 0;min-height:30px;display:inline-flex;align-items:center;justify-content:center;gap:4px;
padding:4px 5px;border-radius:8px;font-size:11px;font-weight:650;color:var(--hud-dim);text-align:center}
.hud-tab[aria-selected="true"]{background:rgba(255,255,255,.12);color:#fff}
.hud-tab:hover{background:rgba(255,255,255,.07)}
.hud-tab:focus-visible{outline:2px solid var(--hud-accent);outline-offset:1px}
.hud-count{min-width:15px;height:15px;padding:0 4px;border-radius:999px;background:var(--hud-warn);color:#1a1206;font-size:9px;font-weight:800;display:inline-grid;place-items:center}
.hud-count-blue{background:var(--hud-accent);color:#04122b}
.hud-tools{display:flex;align-items:center;gap:4px;padding:5px 7px;border-bottom:1px solid var(--hud-line);flex-wrap:wrap;flex:0 0 auto}
.hud-swatch{all:unset;box-sizing:border-box;cursor:pointer;width:20px;height:20px;border-radius:999px;border:2px solid transparent;flex:0 0 auto}
.hud-swatch[aria-pressed="true"]{border-color:#fff}
.hud-swatch:focus-visible{outline:2px solid var(--hud-accent);outline-offset:1px}
.hud-person{display:flex;align-items:center;gap:6px;padding:6px;border-radius:8px;background:rgba(255,255,255,.04);margin-bottom:5px}
.hud-person:last-child{margin-bottom:0}
.hud-person-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:11px}
.hud-person-sub{font-size:10px;color:var(--hud-dim);font-weight:500}
.hud-chip{display:inline-block;font-size:9px;font-weight:700;padding:1px 4px;border-radius:999px;border:1px solid var(--hud-line);color:var(--hud-dim);white-space:nowrap}
.hud-chip-muted{color:#fcd34d;border-color:rgba(245,158,11,.4);background:rgba(245,158,11,.12)}
.hud-pill{position:fixed;right:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));z-index:60;display:flex;gap:6px;align-items:center}
.hud-sheet{position:fixed;left:0;right:0;bottom:0;z-index:60;max-height:min(55dvh,420px);border-top:1px solid var(--hud-line);
border-radius:14px 14px 0 0;overflow:hidden;box-shadow:0 -12px 40px rgba(0,0,0,.55);padding-bottom:env(safe-area-inset-bottom,0px)}
.hud-sheet .hud-root{max-height:min(55dvh,420px);border-radius:14px 14px 0 0}
.hud-grab{height:18px;display:grid;place-items:center;flex:0 0 auto;background:rgba(0,0,0,.45);cursor:grab}
.hud-grab::before{content:"";width:34px;height:3px;border-radius:999px;background:rgba(255,255,255,.28)}
@media (pointer:coarse){
.hud-btn{min-height:40px;padding:7px 10px;font-size:12px}
.hud-btn-sm{min-height:34px}
.hud-tab{min-height:40px}
.hud-swatch{width:26px;height:26px}
.hud-x{width:34px;height:34px;min-width:34px}
}
`;

/* ------------------------------------------------------------------ PiP glue */

type DocumentPictureInPictureApi = {
  requestWindow: (opts?: { width?: number; height?: number }) => Promise<Window>;
};

function getDocumentPip(): DocumentPictureInPictureApi | null {
  if (typeof window === 'undefined') return null;
  const api = (window as unknown as { documentPictureInPicture?: DocumentPictureInPictureApi })
    .documentPictureInPicture;
  return api && typeof api.requestWindow === 'function' ? api : null;
}

export function supportsDocumentPip(): boolean {
  return getDocumentPip() !== null;
}

/**
 * Copy the host document's stylesheets into the popup so Tailwind children
 * (Chat) render correctly there. Best effort: the HUD's own chrome is
 * self-contained via HUD_CSS and does not depend on this succeeding.
 */
function adoptStyles(doc: Document) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      if (sheet instanceof CSSStyleSheet && sheet.href) {
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        doc.head.appendChild(link);
      } else if (sheet instanceof CSSStyleSheet) {
        const style = doc.createElement('style');
        style.textContent = Array.from(sheet.cssRules)
          .map((r) => r.cssText)
          .join('\n');
        doc.head.appendChild(style);
      }
    } catch {
      /* cross-origin sheet we cannot read; the <link> branch covers most */
    }
  }
  const meta = doc.createElement('meta');
  meta.name = 'viewport';
  meta.content = 'width=device-width, initial-scale=1';
  doc.head.appendChild(meta);
  const html = doc.documentElement;
  html.style.height = '100%';
  doc.body.style.height = '100%';
  doc.body.style.margin = '0';
  doc.body.style.background = 'var(--hud-bg, #0d1219)';
  doc.title = 'Class controls';
}

/* ------------------------------------------------------------------ the HUD */

export type RosterEntry = {
  id: string;
  displayName: string;
  role: string;
  mutedByTeacher?: boolean;
  isVisible?: boolean;
  handRaised?: boolean;
};

export type TeacherShareHudProps = {
  code: string;
  admitted: RosterEntry[];
  waitingCount?: number;
  teacherMicOn: boolean;
  onToggleTeacherMic: () => void;
  onStopSharing: () => void;
  onMuteStudent: (participantId: string, muted: boolean) => void;
  onMuteAll: (muted: boolean) => void;
  onLowerHand: (participantId: string) => void;
  teacherParticipantId: string | null;
  chatUnread: number;
  onChatUnread: (n: number) => void;
  classEnded: boolean;
  /** Called when the teacher closes the HUD. Never stops the share. */
  onClose: () => void;
  /** Upgrade from the in-page sheet to a real window. */
  onPopOut: () => void;
  canPopOut: boolean;
  /** Shared annotate transport — drawing happens on the classroom stage, not in this HUD. */
  annotate: ReturnType<typeof useScreenAnnotate>;
  annotateOn: boolean;
  onAnnotateOnChange: (on: boolean) => void;
  annotateMode: AnnotateMode;
  onAnnotateModeChange: (mode: AnnotateMode) => void;
  annotateColor: string;
  onAnnotateColorChange: (color: string) => void;
};

const TOOL_LABEL: Record<AnnotateMode, string> = {
  pen: 'Pen',
  highlighter: 'Highlighter',
  eraser: 'Eraser',
};

/** Presentational HUD body. Rendered into whichever host window is active. */
function HudBody({
  props,
  onClose,
  onCollapse,
  expanded,
  inPage,
}: {
  props: TeacherShareHudProps;
  onClose: () => void;
  /** Collapses to the compact pill. Only offered by the in-page host. */
  onCollapse?: () => void;
  expanded: boolean;
  /** True for the in-page sheet, where the mobile backgrounding caveat applies. */
  inPage?: boolean;
}) {
  const {
    code,
    admitted,
    waitingCount = 0,
    teacherMicOn,
    onToggleTeacherMic,
    onStopSharing,
    onMuteStudent,
    onMuteAll,
    onLowerHand,
    teacherParticipantId,
    chatUnread,
    onChatUnread,
    classEnded,
    onPopOut,
    canPopOut,
    annotate,
    annotateOn,
    onAnnotateOnChange,
    annotateMode: mode,
    onAnnotateModeChange: setMode,
    annotateColor: color,
    onAnnotateColorChange: setColor,
  } = props;

  const [tab, setTab] = useState<'chat' | 'hands' | 'roster'>('chat');

  const students = useMemo(() => admitted.filter((a) => a.role === 'STUDENT'), [admitted]);
  const hands = useMemo(() => students.filter((s) => s.handRaised), [students]);

  return (
    <div className="hud-root">
      <style>{HUD_CSS}</style>
      <div className="hud-head">
        <span className="hud-badge hud-badge-live">Live</span>
        <span className="hud-title">Class controls</span>
        <span className="hud-badge">{code}</span>
        {canPopOut && (
          <button
            type="button"
            className="hud-btn hud-btn-sm"
            onClick={onPopOut}
            title="Open in its own always-on-top window"
          >
            Pop out
          </button>
        )}
        {onCollapse && (
          <button
            type="button"
            className="hud-x"
            onClick={onCollapse}
            aria-label="Collapse to a small button"
            title="Collapse"
          >
            –
          </button>
        )}
        <button type="button" className="hud-x" onClick={onClose} aria-label="Close controls">
          ✕
        </button>
      </div>

      {annotateOn && (
        <div className="hud-tools" role="toolbar" aria-label="Annotation tools">
          {(['pen', 'highlighter', 'eraser'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className="hud-btn hud-btn-sm"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
            >
              {TOOL_LABEL[m]}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          {ANNOTATE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className="hud-swatch"
              style={{ background: c }}
              aria-label={`Colour ${c}`}
              aria-pressed={color === c}
              onClick={() => setColor(c)}
            />
          ))}
          <button
            type="button"
            className="hud-btn hud-btn-sm"
            onClick={annotate.clear}
            disabled={!annotate.strokes.length}
          >
            Clear
          </button>
        </div>
      )}

      <div className="hud-row">
        <button
          type="button"
          className="hud-btn"
          aria-pressed={!teacherMicOn}
          onClick={onToggleTeacherMic}
        >
          {teacherMicOn ? <IconMic size={15} /> : <IconMicOff size={15} />}
          {teacherMicOn ? 'Mic on' : 'Mic off'}
        </button>
        <button
          type="button"
          className="hud-btn"
          aria-pressed={annotateOn}
          onClick={() => onAnnotateOnChange(!annotateOn)}
        >
          Annotate
        </button>
        <button type="button" className="hud-btn hud-btn-danger" onClick={onStopSharing}>
          <IconScreen size={15} />
          Stop share
        </button>
      </div>

      <div className="hud-row">
        <button type="button" className="hud-btn" onClick={() => onMuteAll(true)}>
          Mute all
        </button>
        <button type="button" className="hud-btn" onClick={() => onMuteAll(false)}>
          Unmute all
        </button>
        {waitingCount > 0 && (
          <span className="hud-chip">{waitingCount} waiting</span>
        )}
      </div>

      <div className="hud-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className="hud-tab"
          aria-selected={tab === 'chat'}
          onClick={() => setTab('chat')}
        >
          <IconChat size={13} /> Chat
          {chatUnread > 0 && (
            <span className="hud-count">{chatUnread > 9 ? '9+' : chatUnread}</span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          className="hud-tab"
          aria-selected={tab === 'hands'}
          onClick={() => setTab('hands')}
        >
          <IconHand size={13} /> Hands
          {hands.length > 0 && <span className="hud-count">{hands.length}</span>}
        </button>
        <button
          type="button"
          role="tab"
          className="hud-tab"
          aria-selected={tab === 'roster'}
          onClick={() => setTab('roster')}
        >
          <IconUsers size={13} /> Roster
          <span className="hud-count hud-count-blue">{students.length}</span>
        </button>
      </div>

      <div className="hud-body">
        {tab === 'chat' && (
          <Chat
            code={code}
            isTeacher
            myParticipantId={teacherParticipantId}
            students={students.map((s) => ({ id: s.id, displayName: s.displayName }))}
            active={true}
            onUnreadChange={onChatUnread}
            stopped={classEnded}
          />
        )}

        {tab === 'hands' && (
          <div className="hud-scroll">
            {hands.length === 0 ? (
              <p className="hud-empty">No raised hands.</p>
            ) : (
              hands.map((s) => (
                <div className="hud-person" key={s.id}>
                  <Avatar name={s.displayName} size="sm" />
                  <span className="hud-person-name">
                    {s.displayName}
                    <span className="hud-person-sub"> · raised hand</span>
                  </span>
                  <button
                    type="button"
                    className="hud-btn hud-btn-sm"
                    onClick={() => onLowerHand(s.id)}
                  >
                    Lower
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {tab === 'roster' && (
          <div className="hud-scroll">
            {students.length === 0 ? (
              <p className="hud-empty">No students yet.</p>
            ) : (
              students.map((s) => (
                <div className="hud-person" key={s.id}>
                  <Avatar name={s.displayName} size="sm" />
                  <span className="hud-person-name">
                    {s.displayName}
                    <span className="hud-person-sub" style={{ display: 'block' }}>
                      {s.mutedByTeacher
                        ? 'muted by you'
                        : s.isVisible
                          ? 'in sample'
                          : 'local only'}
                    </span>
                  </span>
                  {s.mutedByTeacher ? <span className="hud-chip hud-chip-muted">muted</span> : null}
                  <button
                    type="button"
                    className="hud-btn hud-btn-sm"
                    onClick={() => onMuteStudent(s.id, !s.mutedByTeacher)}
                  >
                    {s.mutedByTeacher ? 'Unmute' : 'Mute'}
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <p className="hud-note">
        Draw on the shared screen in the classroom tab. Closing these
        controls does not stop sharing.
        {inPage
          ? ' In-page controls stop responding if you switch apps — keep Classroom in split view, or minimise the browser with its picture-in-picture, if you need to leave it.'
          : !expanded
            ? ' Tap “Controls” to reopen.'
            : ''}
      </p>
    </div>
  );
}

/** Collapsed in-page affordance: a pill that never covers the whole screen. */
function HudPill({
  props,
  onExpand,
}: {
  props: TeacherShareHudProps;
  onExpand: () => void;
}) {
  const hands = props.admitted.filter((a) => a.role === 'STUDENT' && a.handRaised).length;
  return (
    <div className="hud-root">
      <style>{HUD_CSS}</style>
      <div className="hud-pill">
        <button type="button" className="hud-btn" onClick={onExpand}>
          <IconUsers size={15} /> Controls
          {props.chatUnread > 0 && (
            <span className="hud-count">{props.chatUnread > 9 ? '9+' : props.chatUnread}</span>
          )}
          {hands > 0 && <span className="hud-count">{hands}</span>}
        </button>
        <button
          type="button"
          className="hud-btn hud-btn-danger"
          onClick={props.onStopSharing}
          aria-label="Stop sharing"
        >
          <IconScreen size={15} />
        </button>
      </div>
    </div>
  );
}

export type UseShareHud = {
  host: HudHost | null;
  /** Portal target: a foreign document body, or null for the in-page sheet. */
  container: HTMLElement | null;
  expanded: boolean;
  setExpanded: (v: boolean) => void;
  open: () => HudHost;
  close: () => void;
  /** True when a native window host is currently in use. */
  detached: boolean;
};

/**
 * Owns the HUD window lifecycle.
 *
 * `open()` performs the OS-level window request synchronously so it can be
 * called straight from a click handler; a refused or unavailable request falls
 * back to the in-page sheet rather than failing.
 */
export function useShareHud(): UseShareHud {
  const [host, setHost] = useState<HudHost | null>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [expanded, setExpanded] = useState(true);
  const winRef = useRef<Window | null>(null);

  const teardown = useCallback(() => {
    const win = winRef.current;
    winRef.current = null;
    if (win && !win.closed) {
      try {
        win.close();
      } catch {
        /* ignore */
      }
    }
  }, []);

  const close = useCallback(() => {
    teardown();
    setContainer(null);
    setHost(null);
    setExpanded(true);
  }, [teardown]);

  const open = useCallback((): HudHost => {
    // Already detached — nothing to do.
    if (winRef.current && !winRef.current.closed) return host ?? 'inline';

    const pip = getDocumentPip();
    if (pip) {
      let request: Promise<Window> | null = null;
      try {
        // Must be called synchronously: Document PiP requires user activation.
        request = pip.requestWindow({ width: 300, height: 420 });
      } catch {
        request = null;
      }
      if (request) {
        setHost('pip');
        setExpanded(true);
        request
          .then((win) => {
            winRef.current = win;
            adoptStyles(win.document);
            setContainer(win.document.body);
            win.addEventListener('pagehide', () => {
              // Teacher closed the PiP window by hand.
              winRef.current = null;
              setContainer(null);
              setHost(null);
            });
          })
          .catch(() => {
            setHost('inline');
            setContainer(null);
            setExpanded(true);
          });
        return 'pip';
      }
    }

    // Popup fallback. It must be opened on a *same-origin* URL: an empty URL
    // yields a document with an opaque origin, and the popup's fetches would
    // then be cross-origin, so the browser omits the session cookies and every
    // HUD action 401s. /hud is an empty shell the HUD is portalled into.
    try {
      const win = window.open(
        '/hud',
        'classroom-hud',
        `popup=yes,width=300,height=420,left=${Math.max(0, window.screenX + 60)},top=${Math.max(0, window.screenY + 60)}`
      );
      if (win) {
        winRef.current = win;
        setHost('popup');
        setExpanded(true);

        // Wait for the navigation to finish; portalling into the initial
        // about:blank document would be discarded on load.
        const mount = () => {
          // Defensive: if the browser still gave us an opaque origin, silently
          // degrade to the in-page sheet rather than ship a HUD whose every
          // action fails with a 401.
          let sameOrigin = false;
          try {
            sameOrigin = win.location.origin === window.location.origin;
          } catch {
            sameOrigin = false;
          }
          if (!sameOrigin) {
            winRef.current = null;
            try {
              win.close();
            } catch {
              /* ignore */
            }
            setHost('inline');
            setContainer(null);
            return;
          }
          adoptStyles(win.document);
          setContainer(win.document.body);
        };
        if (win.document.readyState === 'complete') mount();
        else win.addEventListener('load', mount, { once: true });
        return 'popup';
      }
    } catch {
      /* blocked */
    }

    setHost('inline');
    setContainer(null);
    setExpanded(true);
    return 'inline';
  }, [host]);

  // A popup the user closed without a pagehide (e.g. tab discarded) still needs
  // the HUD to fall back rather than point at a dead document.
  useEffect(() => {
    if (host !== 'popup') return;
    const t = window.setInterval(() => {
      const win = winRef.current;
      if (win && win.closed) {
        winRef.current = null;
        setContainer(null);
        setHost(null);
      }
    }, 1_000);
    return () => window.clearInterval(t);
  }, [host]);

  useEffect(() => {
    return () => {
      teardown();
    };
  }, [teardown]);

  return {
    host,
    container,
    expanded,
    setExpanded,
    open,
    close,
    detached: host === 'pip' || host === 'popup',
  };
}

/**
 * Renders the HUD in the best available host. Renders nothing when closed.
 */
export function TeacherShareHud(props: TeacherShareHudProps & { hud: UseShareHud }) {
  const { hud, onClose, onPopOut, canPopOut: canPopOutProp } = props;
  // Only offer "Pop out" while we are still in-page; a detached host is already
  // a separate window and there is nothing further to upgrade to.
  const canPopOut = hud.host === 'inline' && canPopOutProp;

  const content = (() => {
    if (hud.host === 'inline') {
      if (!hud.expanded) {
        return <HudPill props={{ ...props, onPopOut, canPopOut }} onExpand={() => hud.setExpanded(true)} />;
      }
      return (
        <div className="hud-sheet">
          <div className="hud-grab" aria-hidden="true" />
          <HudBody
            props={{ ...props, onPopOut, canPopOut }}
            onClose={onClose}
            onCollapse={() => hud.setExpanded(false)}
            expanded
            inPage
          />
        </div>
      );
    }
    return <HudBody props={{ ...props, onPopOut, canPopOut }} onClose={onClose} expanded />;
  })();

  // A detached window renders through a portal into that document.
  if (hud.detached && hud.container) {
    return createPortal(content, hud.container);
  }
  if (hud.host === 'inline') return content;
  return null;
}

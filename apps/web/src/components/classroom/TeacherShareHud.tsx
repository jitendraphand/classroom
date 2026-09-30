'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Avatar } from '@/components/ui/Avatar';
import {
  ANNOTATE_COLORS,
  useScreenAnnotate,
  type AnnotateMode,
} from './ScreenAnnotator';
import { IconChat, IconHand, IconMic, IconMicOff, IconScreen, IconUsers } from '@/components/ui/Icons';

/**
 * Compact teacher-only floating control bar shown while screen sharing.
 *
 * Intentionally inline (no Document PiP / popup): those consume the same user
 * gesture as getDisplayMedia, which caused the "first click opens HUD, second
 * click starts share" bug. A slim bar also works on mobile and stays small.
 *
 * Students never render this component.
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
  admitted: RosterEntry[];
  /** Students still in the waiting room. Admitted from this bar without stopping the share. */
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
  /** Shared chat thread UI. Unread is owned by the parent so it survives this panel closing. */
  chat?: ReactNode;
  onChatOpenChange?: (open: boolean) => void;
  /** Closing the HUD never stops the share. */
  onClose: () => void;
  annotate: ReturnType<typeof useScreenAnnotate>;
  annotateOn: boolean;
  onAnnotateOnChange: (on: boolean) => void;
  annotateMode: AnnotateMode;
  onAnnotateModeChange: (mode: AnnotateMode) => void;
  annotateColor: string;
  onAnnotateColorChange: (color: string) => void;
  /** Optional browser-limit tip shown under the bar (e.g. mobile). */
  notice?: string;
};

type Panel = 'chat' | 'hands' | 'roster' | null;

const TOOL_LABEL: Record<AnnotateMode, string> = {
  pen: 'Pen',
  highlighter: 'Highlighter',
  eraser: 'Eraser',
};

const HUD_CSS = `
.tsh{--bg:#0d1219;--line:rgba(255,255,255,.12);--text:#eef2ff;--dim:#94a3b8;--accent:#3385ff;--warn:#f59e0b;
position:relative;z-index:40;width:min(560px,calc(100% - 16px));margin:0 auto 8px;flex-shrink:0;
display:flex;flex-direction:column;gap:6px;pointer-events:none;
font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:12px;line-height:1.3;color:var(--text)}
.tsh-pip{width:auto;margin:0;padding:8px}
.tsh-wait{pointer-events:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 8px;border-radius:12px;
background:rgba(245,158,11,.16);border:1px solid rgba(245,158,11,.45);color:#fde68a}
.tsh-wait-name{flex:1;min-width:0;font-weight:700;font-size:12px}
.tsh-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.tsh *{box-sizing:border-box}
.tsh-bar,.tsh-tools,.tsh-panel,.tsh-tip{pointer-events:auto;background:rgba(13,18,25,.94);border:1px solid var(--line);
backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:0 10px 36px rgba(0,0,0,.45)}
.tsh-bar{display:flex;align-items:center;gap:4px;padding:5px 6px;border-radius:14px;flex-wrap:wrap}
.tsh-tools{display:flex;align-items:center;gap:4px;padding:5px 7px;border-radius:12px;flex-wrap:wrap}
.tsh-panel{border-radius:14px;overflow:hidden;max-height:min(42dvh,360px);display:flex;flex-direction:column}
.tsh-tip{border-radius:10px;padding:6px 9px;font-size:10.5px;line-height:1.4;color:#fde68a;background:rgba(245,158,11,.16);border-color:rgba(245,158,11,.35)}
.tsh-live{font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;padding:2px 6px;border-radius:999px;
color:#bbf7d0;border:1px solid rgba(34,197,94,.4);background:rgba(34,197,94,.14);white-space:nowrap}
.tsh-title{font-weight:650;font-size:11px;color:var(--dim);margin-right:2px;white-space:nowrap}
.tsh-sep{width:1px;height:22px;background:var(--line);margin:0 2px;flex:0 0 auto}
.tsh-btn{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:4px;
min-height:32px;min-width:32px;padding:4px 8px;border-radius:10px;border:1px solid transparent;color:var(--text);
font-size:11px;font-weight:600;line-height:1.15;position:relative}
.tsh-btn:hover{background:rgba(255,255,255,.1)}
.tsh-btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.tsh-btn[aria-pressed="true"]{background:rgba(51,133,255,.28);border-color:rgba(51,133,255,.55)}
.tsh-btn-danger{color:#fecaca}
.tsh-btn-danger:hover,.tsh-btn-danger[aria-pressed="true"]{background:rgba(239,68,68,.28);border-color:rgba(239,68,68,.5)}
.tsh-btn[disabled]{opacity:.4;cursor:default}
.tsh-count{position:absolute;top:-3px;right:-3px;min-width:14px;height:14px;padding:0 3px;border-radius:999px;
background:var(--warn);color:#1a1206;font-size:9px;font-weight:800;display:inline-grid;place-items:center}
.tsh-count-blue{background:var(--accent);color:#04122b}
.tsh-swatch{all:unset;box-sizing:border-box;cursor:pointer;width:18px;height:18px;border-radius:999px;border:2px solid transparent;flex:0 0 auto}
.tsh-swatch[aria-pressed="true"]{border-color:#fff}
.tsh-panel-head{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--line);flex:0 0 auto}
.tsh-panel-title{font-weight:650;font-size:11px;flex:1}
.tsh-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:6px 8px;-webkit-overflow-scrolling:touch}
.tsh-empty{color:var(--dim);font-size:11px;text-align:center;padding:16px 8px;margin:0}
.tsh-person{display:flex;align-items:center;gap:6px;padding:6px;border-radius:8px;background:rgba(255,255,255,.04);margin-bottom:5px}
.tsh-person:last-child{margin-bottom:0}
.tsh-person-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:11px}
.tsh-person-sub{font-size:10px;color:var(--dim);font-weight:500}
.tsh-chip{display:inline-block;font-size:9px;font-weight:700;padding:1px 4px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
.tsh-chip-muted{color:#fcd34d;border-color:rgba(245,158,11,.4);background:rgba(245,158,11,.12)}
.tsh-chat{height:min(38dvh,300px);min-height:180px}
@media (pointer:coarse){
.tsh-btn{min-height:40px;min-width:40px;padding:6px 10px;font-size:12px}
.tsh-swatch{width:24px;height:24px}
}
`;

export function TeacherShareHud(props: TeacherShareHudProps) {
  const {
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
    onClose,
    annotate,
    annotateOn,
    onAnnotateOnChange,
    annotateMode: mode,
    onAnnotateModeChange: setMode,
    annotateColor: color,
    onAnnotateColorChange: setColor,
    notice,
  } = props;

  const [panel, setPanel] = useState<Panel>(null);
  const [pipBody, setPipBody] = useState<HTMLElement | null>(null);
  const [pipNote, setPipNote] = useState('');
  const prevWaiting = useRef(waitingCount);

  useEffect(() => {
    if (waitingCount > prevWaiting.current) setPanel('roster');
    prevWaiting.current = waitingCount;
  }, [waitingCount]);

  useEffect(() => {
    onChatOpenChange?.(panel === 'chat');
  }, [panel, onChatOpenChange]);

  useEffect(() => {
    return () => onChatOpenChange?.(false);
  }, [onChatOpenChange]);

  const students = useMemo(() => admitted.filter((a) => a.role === 'STUDENT'), [admitted]);
  const hands = useMemo(() => students.filter((s) => s.handRaised), [students]);

  const togglePanel = (p: Exclude<Panel, null>) => {
    setPanel((cur) => (cur === p ? null : p));
  };

  async function popOut() {
    const api = (
      window as Window & {
        documentPictureInPicture?: {
          requestWindow: (opts: { width: number; height: number }) => Promise<Window>;
        };
      }
    ).documentPictureInPicture;
    if (!api || !window.isSecureContext) {
      setPipNote('Pop-out controls need desktop Chrome or Edge. This bar stays above the class controls.');
      return;
    }
    try {
      const pip = await api.requestWindow({ width: 440, height: 320 });
      document.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => {
        pip.document.head.appendChild(node.cloneNode(true));
      });
      pip.document.body.style.margin = '0';
      pip.document.body.style.background = '#0d1219';
      setPipBody(pip.document.body);
      setPipNote('');
      // pagehide is the last moment the pop-out document is still alive.
      // A deferred setState runs after Chrome destroys it and the controls never return.
      pip.addEventListener(
        'pagehide',
        () => {
          try {
            flushSync(() => setPipBody(null));
          } catch {
            setPipBody(null);
          }
        },
        { once: true }
      );
    } catch {
      setPipNote('Could not pop the controls out. They stay on this page, above the class controls.');
    }
  }

  const waitingLabel =
    waitingCount === 1
      ? `${waiting[0]?.displayName || 'A student'} is waiting to join`
      : waitingCount > 1
        ? `${waitingCount} students are waiting to join`
        : '';

  const tree = (
    <div className={pipBody ? 'tsh tsh-pip' : 'tsh'} role="region" aria-label="Share controls">
      <style>{HUD_CSS}</style>
      <div className="tsh-sr" aria-live="polite">
        {waitingLabel}
      </div>

      {notice ? <div className="tsh-tip">{notice}</div> : null}
      {pipNote ? <div className="tsh-tip">{pipNote}</div> : null}

      {waiting.length > 0 && (
        <div className="tsh-wait" role="status">
          <span className="tsh-wait-name">{waitingLabel}</span>
          <button type="button" className="tsh-btn" onClick={() => onAdmit?.(waiting[0].id)}>
            Admit
          </button>
          {waiting.length > 1 && (
            <button type="button" className="tsh-btn" onClick={() => onAdmitAll?.()}>
              Admit all
            </button>
          )}
        </div>
      )}

      {panel === 'chat' && (
        <div className="tsh-panel">
          <div className="tsh-panel-head">
            <span className="tsh-panel-title">Chat</span>
            <button type="button" className="tsh-btn" onClick={() => setPanel(null)} aria-label="Close chat">
              ✕
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
              ✕
            </button>
          </div>
          <div className="tsh-scroll">
            {hands.length === 0 ? (
              <p className="tsh-empty">No raised hands.</p>
            ) : (
              hands.map((s) => (
                <div className="tsh-person" key={s.id}>
                  <Avatar name={s.displayName} size="sm" />
                  <span className="tsh-person-name">
                    {s.displayName}
                    <span className="tsh-person-sub"> · raised</span>
                  </span>
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
              ✕
            </button>
          </div>
          <div className="tsh-scroll">
            {waiting.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  <span className="tsh-panel-title">Waiting</span>
                  <button type="button" className="tsh-btn" onClick={() => onAdmitAll?.()}>
                    Admit all
                  </button>
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
            <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
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
                      {s.mutedByTeacher
                        ? 'muted by you'
                        : s.isVisible
                          ? 'in sample'
                          : 'local only'}
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

      {annotateOn && (
        <div className="tsh-tools" role="toolbar" aria-label="Annotation tools">
          {(['pen', 'highlighter', 'eraser'] as const).map((m) => (
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
          <span style={{ flex: 1 }} />
          {ANNOTATE_COLORS.map((c) => (
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
          <button
            type="button"
            className="tsh-btn"
            onClick={annotate.clear}
            disabled={!annotate.strokes.length}
          >
            Clear
          </button>
        </div>
      )}

      <div className="tsh-bar">
        <span className="tsh-live">Live</span>
        <span className="tsh-title">Share</span>

        <button
          type="button"
          className="tsh-btn"
          aria-pressed={!teacherMicOn}
          onClick={onToggleTeacherMic}
          title={teacherMicOn ? 'Mute mic' : 'Unmute mic'}
          aria-label={teacherMicOn ? 'Mute mic' : 'Unmute mic'}
        >
          {teacherMicOn ? <IconMic size={15} /> : <IconMicOff size={15} />}
        </button>

        <button
          type="button"
          className="tsh-btn"
          aria-pressed={annotateOn}
          onClick={() => onAnnotateOnChange(!annotateOn)}
          title="Annotate on shared screen"
        >
          Annotate
        </button>

        <span className="tsh-sep" aria-hidden />

        <button
          type="button"
          className="tsh-btn"
          aria-pressed={panel === 'chat'}
          onClick={() => togglePanel('chat')}
          title="Chat"
          aria-label="Chat"
        >
          <IconChat size={15} />
          {chatUnread > 0 && panel !== 'chat' && (
            <span className="tsh-count">{chatUnread > 9 ? '9+' : chatUnread}</span>
          )}
        </button>

        <button
          type="button"
          className="tsh-btn"
          aria-pressed={panel === 'hands'}
          onClick={() => togglePanel('hands')}
          title="Raised hands"
          aria-label="Raised hands"
        >
          <IconHand size={15} />
          {hands.length > 0 && panel !== 'hands' && (
            <span className="tsh-count">{hands.length}</span>
          )}
        </button>

        <button
          type="button"
          className="tsh-btn"
          aria-pressed={panel === 'roster'}
          onClick={() => togglePanel('roster')}
          title="Roster"
          aria-label="Roster"
        >
          <IconUsers size={15} />
          {waitingCount > 0 && panel !== 'roster' ? (
            <span className="tsh-count">{waitingCount > 9 ? '9+' : waitingCount}</span>
          ) : students.length > 0 && panel !== 'roster' ? (
            <span className="tsh-count tsh-count-blue">{students.length}</span>
          ) : null}
        </button>

        <span className="tsh-sep" aria-hidden />

        <button
          type="button"
          className="tsh-btn"
          onClick={() => void popOut()}
          aria-label="Pop out share controls"
          title="Keep these controls on screen if this window is minimized"
        >
          Pop out
        </button>

        <button type="button" className="tsh-btn tsh-btn-danger" onClick={onStopSharing} title="Stop sharing">
          <IconScreen size={15} />
          Stop
        </button>

        <button type="button" className="tsh-btn" onClick={onClose} aria-label="Hide share controls" title="Hide controls">
          ✕
        </button>
      </div>
    </div>
  );

  if (pipBody) {
    return (
      <>
        {createPortal(tree, pipBody)}
        <div className="tsh" role="status">
          <div className="tsh-tip">
            Share controls are in the pop-out window. Close that window to dock them here. Screen sharing continues if this window is minimized.
          </div>
        </div>
      </>
    );
  }
  return tree;
}

/** @deprecated Kept for import compatibility; HUD is always inline now. */
export function supportsDocumentPip(): boolean {
  return false;
}

/** Minimal stub — HUD open state is owned by ClassroomRoom. */
export type UseShareHud = {
  host: 'inline' | null;
  container: null;
  expanded: boolean;
  setExpanded: (v: boolean) => void;
  open: () => 'inline';
  close: () => void;
  detached: false;
};

export function useShareHud(): UseShareHud {
  const [host, setHost] = useState<'inline' | null>(null);
  const [expanded, setExpanded] = useState(true);
  return {
    host,
    container: null,
    expanded,
    setExpanded,
    open: () => {
      setHost('inline');
      setExpanded(true);
      return 'inline';
    },
    close: () => {
      setHost(null);
      setExpanded(true);
    },
    detached: false,
  };
}

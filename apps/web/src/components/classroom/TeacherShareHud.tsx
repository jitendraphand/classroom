'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from '@/components/ui/Avatar';
import { IconCam, IconCamOff, IconChat, IconFilm, IconHand, IconHandDown, IconMic, IconMicOff, IconPin, IconScreen, IconUserPlus, IconUsers, IconVideo } from '@/components/ui/Icons';
import { toolbarInnerSize } from '@/lib/sideWindowGeometry';
import { closeSideWindow, openSideWindow, sideWindow, SideWindowPortal, useSideWindows } from './shareSideWindows';
import { sortRoster } from '@/lib/classSlots';
import { filterPeople } from '@/lib/peopleSearch';
import { useFloatDrag, type FloatPos } from './FloatingPanel';
import { focusLabel } from '@/lib/focusStatus';
import { controlUrl, copyParentStyles, mountIn, waitForWindow } from './shareWindowDom';

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
 * or Region Capture can exclude another window from a monitor capture. So on
 * Chrome/Edge the published track is processed first: the window's rectangle
 * is painted black in every frame (lib/screenMaskPipeline.ts) and the PiP
 * stays. Where that is impossible (no insertable streams, several monitors
 * without the Window Management permission, unusable geometry) the window is
 * closed before publishing and the same controls render in the classroom tab
 * (`InlineShareDock`).
 *
 * Both start as a compact pill with badges (chat, hands, waiting) and expand
 * to the full toolbar on click.
 */

export type RosterEntry = {
  id: string;
  displayName: string;
  role: string;
  mutedByTeacher?: boolean;
  isVisible?: boolean;
  handRaised?: boolean;
  handRaisedAt?: number | null;
  pinned?: boolean;
  focus?: import('@/lib/focusStatus').FocusStatus;
  focusIphone?: boolean;
  gradeDivision?: string | null;
  /** School-app student ID (teacher view only), for search. */
  sid?: string | null;
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
  /** Pin / unpin a student's video in the class panel. */
  onTogglePin?: (participantId: string, pinned: boolean) => void;
  chatUnread: number;
  chat?: ReactNode;
  onChatOpenChange?: (open: boolean) => void;
  /**
   * Video mode: the share is tuned for motion (a playing video) — smooth 30 fps
   * over sharpness, more bitrate — instead of sharp text/slides.
   */
  videoMode?: boolean;
  onVideoModeChange?: (on: boolean) => void;
  notice?: string;
  /** Students who left fullscreen or switched away. */
  focusAlertCount?: number;
  /** Small pill with badges; expands to the full toolbar. */
  compact?: boolean;
  onCompactChange?: (compact: boolean) => void;
  /** Render in the classroom page (monitor capture / no pop-out) instead of a portal. */
  inline?: boolean;
  /**
   * Chat and roster may open as separate windows beside the toolbar: the share
   * is a window/tab capture (side windows are not captured) or the whole-screen
   * blackout mask is running (it paints them black). Otherwise they open inside
   * the toolbar (masked with it).
   */
  sideWindowsAllowed?: boolean;
  /** Whole-screen mask running: refuse side windows whose position the browser hides. */
  sideWindowsNeedTrust?: boolean;
  teacherCamOn?: boolean;
  onToggleTeacherCam?: () => void;
  /** Student video window (2/4/6 tiles) beside the toolbar. */
  videosOpen?: boolean;
  onToggleVideos?: () => void;
};

type Panel = 'chat' | 'hands' | 'roster' | null;

/** Compact pill window size (CSS px). Small so it covers little of the screen and of the mask. */
const COMPACT_W = 210;
const COMPACT_H = 36;

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
      // Opens as the compact pill; expanding resizes it (TeacherShareHud fit effect).
      request = pip.requestWindow({ width: COMPACT_W, height: COMPACT_H });
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
.tsh-panel-head{display:flex;align-items:center;gap:6px;padding:4px 8px;border-bottom:1px solid var(--line)}
.tsh-panel-title{font-weight:650;font-size:11px;flex:1}
.tsh-scroll{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 8px}
.tsh-empty{color:var(--dim);font-size:11px;text-align:center;padding:12px 8px;margin:0}
.tsh-person{display:flex;align-items:center;gap:4px;padding:3px 5px;border-radius:8px;background:rgba(255,255,255,.04);margin-bottom:4px}
.tsh-person-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:11px}
.tsh-person-sub{font-size:10px;color:var(--dim);font-weight:500}
.tsh-chip{font-size:9px;font-weight:700;padding:1px 4px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
.tsh-chip-muted{color:#fcd34d;border-color:rgba(245,158,11,.4)}
.tsh-hand{display:inline-flex;vertical-align:-2px;margin-right:4px;color:#fcd34d}
.tsh-pin{display:inline-grid;place-items:center;padding:4px 6px}
.tsh-pin.is-on{background:#f59e0b;color:#111;border-color:#f59e0b}
.tsh-icon{display:inline-grid;place-items:center;width:24px;height:24px;padding:0;flex-shrink:0}
.tsh-icon.is-on{background:#f59e0b;color:#111;border-color:#f59e0b}
.tsh-icon.is-warn{color:#fcd34d;border-color:rgba(245,158,11,.4)}
.tsh-person.is-raised{background:rgba(245,158,11,.12)}
.tsh-person .tsh-chip{max-width:84px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0}
.tsh-chat{height:220px;min-height:160px}
.tsh-admit{max-width:140px;overflow:hidden;text-overflow:ellipsis}
.tsh-pill{gap:2px;padding:3px 4px}
.tsh-pill-main{gap:5px;padding:0 6px}
.tsh-dot{width:8px;height:8px;border-radius:999px;background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.25);flex:0 0 auto}
.tsh-badge{display:inline-flex;align-items:center;gap:2px;height:18px;padding:0 5px;border-radius:999px;background:var(--warn);color:#1a1206;font-size:10px;font-weight:800}
.tsh-badge-dim{background:rgba(245,158,11,.25);color:#fde68a}
.tsh-badge-blue{background:var(--accent);color:#04122b}
.tsh-expand{color:var(--dim);font-size:10px}
.tsh-fill{min-height:100vh;display:flex;flex-direction:column;justify-content:center}
.tsh-side{width:100%;height:100%;display:flex;flex-direction:column}
.tsh-side .tsh-scroll{flex:1 1 auto;padding:8px}
.share-side-chat{height:100%;display:flex;flex-direction:column;padding:8px;box-sizing:border-box}
.tsh-search{width:100%;box-sizing:border-box;margin:0 0 8px;height:28px;padding:0 8px;border-radius:8px;border:1px solid var(--line);background:rgba(255,255,255,.06);color:var(--text);font:inherit;font-size:12px}
.tsh-search:focus{outline:none;border-color:rgba(51,133,255,.7)}
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
    onTogglePin,
    chatUnread,
    chat,
    onChatOpenChange,
    videoMode = false,
    onVideoModeChange,
    notice,
    inline = false,
    compact = false,
    onCompactChange,
    focusAlertCount = 0,
    sideWindowsAllowed = false,
    sideWindowsNeedTrust = false,
    teacherCamOn,
    onToggleTeacherCam,
    videosOpen = false,
    onToggleVideos,
  } = props;
  useSideWindows();
  const chatWin = sideWindowsAllowed ? sideWindow('chat') : null;
  const rosterWin = sideWindowsAllowed ? sideWindow('roster') : null;
  const [sideNotice, setSideNotice] = useState('');

  const [panel, setPanel] = useState<Panel>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastFit = useRef<{ w: number; h: number } | null>(null);
  // A new waiting student does NOT open the roster by itself. Document PiP and
  // pop-ups refuse resizeTo() without a user gesture, so an auto-opened panel
  // could not grow the window. The bar already shows a waiting badge and an
  // "Admit <name>" button; the teacher opens the roster with a click.

  useEffect(() => {
    onChatOpenChange?.(panel === 'chat' || !!chatWin);
  }, [panel, chatWin, onChatOpenChange]);

  useEffect(() => {
    return () => onChatOpenChange?.(false);
  }, [onChatOpenChange]);

  // Side windows belong to this share: close them when the controls go away
  // or separate windows stop being safe (e.g. switched to the entire screen
  // without a mask).
  useEffect(() => {
    if (!sideWindowsAllowed) {
      closeSideWindow('chat');
      closeSideWindow('roster');
    }
  }, [sideWindowsAllowed]);
  useEffect(
    () => () => {
      closeSideWindow('chat');
      closeSideWindow('roster');
    },
    []
  );

  useEffect(() => {
    const win = hostWindow;
    const root = rootRef.current;
    if (!win || !root || win.closed) return;
    // Document PiP refuses resizeTo() without a click. If the content grew on
    // its own (a badge, a notice), shrink it to fit instead of clipping the
    // Stop button; the next click in the toolbar resizes the window properly.
    const applyZoom = () => {
      if (win.closed) return;
      const want = lastFit.current;
      if (!want) return;
      const zw = win.innerWidth > 0 && want.w > win.innerWidth + 1 ? win.innerWidth / want.w : 1;
      const zh = win.innerHeight > 0 && want.h > win.innerHeight + 1 ? win.innerHeight / want.h : 1;
      const z = Math.max(0.6, Math.min(zw, zh));
      root.style.zoom = z < 0.999 ? String(z) : '';
    };
    const onPointer = () => {
      if (root.style.zoom) fit();
    };
    const fit = () => {
      if (win.closed) return;
      root.style.zoom = '';
      const bar = root.querySelector('.tsh-bar') as HTMLElement | null;
      let barW = 0;
      let barH = 0;
      if (bar) {
        const styles = win.getComputedStyle(bar);
        const gap = parseFloat(styles.columnGap || styles.gap || '0') || 0;
        const kids = Array.from(bar.children) as HTMLElement[];
        barW = kids.reduce((sum, el, i) => sum + el.offsetWidth + (i ? gap : 0), 0);
        barW += (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
        barH = bar.offsetHeight;
      }
      // Just the row of controls (plus the in-toolbar panel only in the
      // fallback, when separate windows are not available): no empty band.
      const inPanel = !!panel && !compact;
      const contentW = inPanel ? Math.max(barW, root.scrollWidth) : barW;
      const contentH = inPanel || notice || sideNotice ? root.scrollHeight : barH || root.scrollHeight;
      const size = toolbarInnerSize({ w: contentW, h: contentH }, { panel: inPanel || !!notice || !!sideNotice });
      if (bar) bar.style.maxWidth = contentW > 980 ? '978px' : '';
      if (Math.abs(win.innerWidth - size.w) <= 1 && Math.abs(win.innerHeight - size.h) <= 1) return;
      const extraW = win.innerWidth > 0 ? Math.max(0, win.outerWidth - win.innerWidth) : 0;
      const extraH = win.innerHeight > 0 ? Math.max(0, win.outerHeight - win.innerHeight) : 0;
      try {
        win.resizeTo(size.w + extraW, size.h + extraH);
      } catch {
        /* some browsers refuse resize without a gesture */
      }
      lastFit.current = size;
      win.requestAnimationFrame(applyZoom);
      win.setTimeout(applyZoom, 200);
    };
    fit();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    ro?.observe(root);
    win.addEventListener('resize', applyZoom);
    win.document.addEventListener('pointerdown', onPointer, true);
    return () => {
      ro?.disconnect();
      win.removeEventListener('resize', applyZoom);
      win.document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [hostWindow, panel, videoMode, waitingCount, notice, sideNotice, compact]);

  // Raised hands first (earliest raise first), then by name.
  const students = useMemo(() => sortRoster(admitted.filter((a) => a.role === 'STUDENT')), [admitted]);
  const hands = useMemo(() => students.filter((s) => s.handRaised), [students]);
  const [rosterQuery, setRosterQuery] = useState('');
  const shownStudents = useMemo(() => filterPeople(students, rosterQuery), [students, rosterQuery]);
  const shownWaiting = useMemo(() => filterPeople(waiting, rosterQuery), [waiting, rosterQuery]);

  const togglePanel = (next: Exclude<Panel, null>) => {
    setPanel((cur) => (cur === next ? null : next));
  };

  /**
   * Chat / roster: a separate window beside the toolbar (toggle), so the
   * toolbar never grows or moves. Falls back to the panel inside the
   * (masked) toolbar when pop-ups are blocked or not safe here.
   */
  const toggleSide = (kind: 'chat' | 'roster') => {
    if (sideWindowsAllowed && !inline) {
      if (sideWindow(kind)) {
        closeSideWindow(kind);
        return;
      }
      const r = openSideWindow(kind, { anchor: hostWindow, requireTrustedPosition: sideWindowsNeedTrust });
      if (r.ok) {
        setPanel(null);
        setSideNotice('');
        return;
      }
      setSideNotice(
        r.reason === 'blocked'
          ? 'Pop-ups are blocked for this site, so this opens here. Allow pop-ups to get a separate window.'
          : 'A separate window cannot be hidden from the entire-screen share on this system, so this opens here.'
      );
    }
    togglePanel(kind);
  };

  if (!host && !inline) return null;

  const waitingLabel =
    waitingCount === 1
      ? `${waiting[0]?.displayName || 'A student'} is waiting`
      : waitingCount > 1
        ? `${waitingCount} students are waiting`
        : '';

  const rosterBody = (
          <div className="tsh-scroll">
            <input
              type="search"
              className="tsh-search"
              placeholder="Search name or SID…"
              value={rosterQuery}
              onChange={(e) => setRosterQuery(e.target.value)}
              aria-label="Search students"
            />
            {shownWaiting.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  <span className="tsh-panel-title">Waiting</span>
                  {waiting.length > 1 && (
                    <button type="button" className="tsh-btn" onClick={() => onAdmitAll?.()}>
                      Admit all
                    </button>
                  )}
                </div>
                {shownWaiting.map((w) => (
                  <div className="tsh-person" key={w.id} title={w.displayName}>
                    <Avatar name={w.displayName} size="xs" />
                    <span className="tsh-person-name">{w.displayName}</span>
                    <button
                      type="button"
                      className="tsh-btn tsh-icon is-warn"
                      onClick={() => onAdmit?.(w.id)}
                      aria-label={`Admit ${w.displayName}`}
                      title={`Admit ${w.displayName}`}
                    >
                      <IconUserPlus size={13} />
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
            ) : shownStudents.length === 0 ? (
              <p className="tsh-empty">No student matches “{rosterQuery.trim()}”.</p>
            ) : (
              shownStudents.map((s) => {
                const focus = focusLabel(s.focus, s.focusIphone);
                return (
                  <div className={s.handRaised ? 'tsh-person is-raised' : 'tsh-person'} key={s.id} title={s.displayName}>
                    {s.handRaised && (
                      <span className="tsh-hand" title="Hand raised" aria-label="Hand raised">
                        <IconHand size={12} />
                      </span>
                    )}
                    <Avatar name={s.displayName} size="xs" />
                    <span className="tsh-person-name">{s.displayName}</span>
                    {s.sid ? <span className="tsh-person-sub">{s.sid}</span> : s.gradeDivision ? <span className="tsh-person-sub">{s.gradeDivision}</span> : null}
                    {focus ? <span className="tsh-chip tsh-chip-muted" title={focus}>{focus}</span> : null}
                    <button
                      type="button"
                      className={s.mutedByTeacher ? 'tsh-btn tsh-icon is-warn' : 'tsh-btn tsh-icon'}
                      aria-pressed={!!s.mutedByTeacher}
                      aria-label={s.mutedByTeacher ? `Unmute ${s.displayName}` : `Mute ${s.displayName}`}
                      title={s.mutedByTeacher ? `Unmute ${s.displayName}` : `Mute ${s.displayName}`}
                      onClick={() => onMuteStudent(s.id, !s.mutedByTeacher)}
                    >
                      {s.mutedByTeacher ? <IconMicOff size={13} /> : <IconMic size={13} />}
                    </button>
                    {onTogglePin && (
                      <button
                        type="button"
                        className={s.pinned ? 'tsh-btn tsh-icon is-on' : 'tsh-btn tsh-icon'}
                        aria-pressed={!!s.pinned}
                        aria-label={s.pinned ? `Unpin ${s.displayName}'s video` : `Pin ${s.displayName}'s video`}
                        title={s.pinned ? `Unpin ${s.displayName}'s video` : `Pin ${s.displayName}'s video`}
                        onClick={() => onTogglePin(s.id, !s.pinned)}
                      >
                        <IconPin size={12} />
                      </button>
                    )}
                    {s.handRaised && (
                      <button
                        type="button"
                        className="tsh-btn tsh-icon is-warn"
                        aria-label={`Lower ${s.displayName}'s hand`}
                        title={`Lower ${s.displayName}'s hand`}
                        onClick={() => onLowerHand(s.id)}
                      >
                        <IconHandDown size={13} />
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
  );

  const tree = (
    <div
      ref={rootRef}
      className={inline ? 'tsh tsh-inline' : !panel && !notice && !sideNotice ? 'tsh tsh-fill' : 'tsh'}
      role="region"
      aria-label="Share controls"
    >
      <style>{HUD_CSS}</style>
      <div className="tsh-sr" aria-live="polite">
        {waitingLabel}
      </div>
      {compact ? (
        <div className="tsh-bar tsh-pill" role="toolbar" aria-label="Share controls (compact)">
          <button
            type="button"
            className="tsh-btn tsh-pill-main"
            onClick={() => onCompactChange?.(false)}
            title="Expand share controls"
            aria-label={`Expand share controls${chatUnread ? `, ${chatUnread} new messages` : ''}${
              hands.length ? `, ${hands.length} raised hands` : ''
            }${waitingCount ? `, ${waitingCount} waiting` : ''}`}
          >
            <span className="tsh-dot" aria-hidden />
            <span className="tsh-live">Live</span>
            {chatUnread > 0 && (
              <span className="tsh-badge tsh-badge-blue" title="New chat message">
                <IconChat size={12} />
                {chatUnread > 9 ? '9+' : chatUnread}
              </span>
            )}
            {hands.length > 0 && (
              <span className="tsh-badge" title="Raised hand">
                <IconHand size={12} />
                {hands.length}
              </span>
            )}
            {focusAlertCount > 0 && (
              <span className="tsh-badge tsh-badge-dim" title="Not in fullscreen / switched away">
                ⛶{focusAlertCount}
              </span>
            )}
            {waitingCount > 0 && (
              <span className="tsh-badge" title="Waiting to be admitted">
                <IconUsers size={12} />
                {waitingCount}
              </span>
            )}
            <span aria-hidden className="tsh-expand">▸</span>
          </button>
          {waiting.length > 0 && (
            <button type="button" className="tsh-btn" onClick={() => onAdmit?.(waiting[0].id)} title={`Admit ${waiting[0].displayName}`}>
              Admit
            </button>
          )}
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
          <button type="button" className="tsh-btn tsh-btn-danger" onClick={onStopSharing} title="Stop sharing" aria-label="Stop sharing">
            <IconScreen size={14} />
          </button>
        </div>
      ) : (
      <div className="tsh-bar" role="toolbar" aria-label="Share tools">
        {onCompactChange && (
          <button
            type="button"
            className="tsh-btn"
            onClick={() => {
              setPanel(null);
              onCompactChange(true);
            }}
            title="Collapse to the small pill"
            aria-label="Collapse share controls"
          >
            ◂
          </button>
        )}
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
        {onToggleTeacherCam && (
          <button
            type="button"
            className="tsh-btn"
            aria-pressed={!teacherCamOn}
            onClick={onToggleTeacherCam}
            aria-label={teacherCamOn ? 'Turn camera off' : 'Turn camera on'}
            title={teacherCamOn ? 'Turn camera off' : 'Turn camera on'}
          >
            {teacherCamOn ? <IconCam size={14} /> : <IconCamOff size={14} />}
          </button>
        )}
        {onToggleVideos && (
          <button
            type="button"
            className="tsh-btn"
            aria-pressed={videosOpen}
            onClick={onToggleVideos}
            aria-label={videosOpen ? 'Close student videos window' : 'Show student videos'}
            title={videosOpen ? 'Close student videos window' : 'Student videos (2/4/6, pins, rotation)'}
          >
            <IconVideo size={14} />
          </button>
        )}
        {onVideoModeChange && (
          <button
            type="button"
            className="tsh-btn"
            aria-pressed={videoMode}
            onClick={() => onVideoModeChange(!videoMode)}
            title={
              videoMode
                ? 'Video mode on: smooth 30 fps for a playing video. Click for sharp slides/text.'
                : 'Playing a video? Video mode sends smooth 30 fps (slides and text get slightly softer).'
            }
            aria-label={videoMode ? 'Video mode on (turn off for slides)' : 'Video mode (smooth playback)'}
          >
            <IconFilm size={14} />
            Video
          </button>
        )}
        <span className="tsh-sep" aria-hidden />
        <button
          type="button"
          className="tsh-btn"
          aria-pressed={panel === 'chat' || !!chatWin}
          onClick={() => toggleSide('chat')}
          aria-label={chatWin ? 'Close chat window' : 'Chat'}
          title={chatWin ? 'Close chat window' : 'Chat'}
        >
          <IconChat size={14} />
          {chatUnread > 0 && panel !== 'chat' && !chatWin && (
            <span className="tsh-count">{chatUnread > 9 ? '9+' : chatUnread}</span>
          )}
        </button>
        <button
          type="button"
          className="tsh-btn"
          aria-pressed={panel === 'hands'}
          onClick={() => (sideWindowsAllowed && !inline ? toggleSide('roster') : togglePanel('hands'))}
          aria-label="Raised hands"
          title="Raised hands (listed first in the roster)"
        >
          <IconHand size={14} />
          {hands.length > 0 && panel !== 'hands' && <span className="tsh-count">{hands.length}</span>}
        </button>
        <button
          type="button"
          className="tsh-btn"
          aria-pressed={panel === 'roster' || !!rosterWin}
          onClick={() => toggleSide('roster')}
          aria-label={rosterWin ? 'Close roster window' : 'Roster'}
          title={rosterWin ? 'Close roster window' : 'Roster'}
        >
          <IconUsers size={14} />
          {waitingCount > 0 && panel !== 'roster' ? (
            <span className="tsh-count">{waitingCount > 9 ? '9+' : waitingCount}</span>
          ) : students.length > 0 && panel !== 'roster' && !rosterWin ? (
            <span className="tsh-count tsh-count-blue">{students.length}</span>
          ) : null}
        </button>
        {/* Always present (fixed width): the toolbar window cannot grow
            without a click, so nothing appears or disappears on its own. */}
        <button
          type="button"
          className={waiting.length > 0 ? 'tsh-btn tsh-icon is-warn' : 'tsh-btn tsh-icon'}
          disabled={waiting.length === 0}
          onClick={() => (waiting.length > 1 ? onAdmitAll?.() : waiting[0] && onAdmit?.(waiting[0].id))}
          aria-label={
            waiting.length > 1
              ? `Admit all ${waiting.length} waiting`
              : waiting[0]
                ? `Admit ${waiting[0].displayName}`
                : 'Nobody waiting'
          }
          title={
            waiting.length > 1
              ? `Admit all ${waiting.length} waiting`
              : waiting[0]
                ? `Admit ${waiting[0].displayName}`
                : 'Nobody waiting'
          }
        >
          <IconUserPlus size={14} />
        </button>
        <span className="tsh-sep" aria-hidden />
        <button type="button" className="tsh-btn tsh-btn-danger" onClick={onStopSharing} title="Stop sharing">
          <IconScreen size={14} />
          Stop
        </button>
      </div>
      )}
      {(notice || sideNotice) && !compact ? <div className="tsh-tip">{sideNotice || notice}</div> : null}

      {!compact && panel === 'chat' && (
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

      {!compact && panel === 'hands' && (
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

      {!compact && panel === 'roster' && (
        <div className="tsh-panel">
          <div className="tsh-panel-head">
            <span className="tsh-panel-title">Roster</span>
            {waitingCount > 0 && <span className="tsh-chip">{waitingCount} waiting</span>}
            <button type="button" className="tsh-btn" onClick={() => setPanel(null)} aria-label="Close roster">
              Close
            </button>
          </div>
          {rosterBody}
        </div>
      )}

      {chatWin && (
        <SideWindowPortal win={chatWin} title="Class chat">
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: 8, boxSizing: 'border-box' }}>{chat}</div>
        </SideWindowPortal>
      )}
      {rosterWin && (
        <SideWindowPortal win={rosterWin} title={waitingCount > 0 ? `Roster · ${waitingCount} waiting` : 'Roster'}>
          <div className="tsh tsh-side" role="region" aria-label="Roster">
            <style>{HUD_CSS}</style>
            {rosterBody}
          </div>
        </SideWindowPortal>
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
  compact = false,
  action,
}: {
  children: ReactNode;
  hint?: string;
  compact?: boolean;
  /** Extra header control (e.g. allow multi-monitor floating controls). */
  action?: ReactNode;
  /** Re-open the floating window (only offered for window/tab captures). */
  onPopOut?: () => void;
}) {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const defaultPos = useCallback(
    (): FloatPos => ({ x: Math.max(8, window.innerWidth - 300), y: window.innerHeight - 160 }),
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
        <span className="flex-1 truncate">{compact ? '' : 'Share controls'}</span>
        {action}
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


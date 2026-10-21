'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from '@/components/ui/Avatar';
import { IconCam, IconCamOff, IconChat, IconFilm, IconHand, IconHandDown, IconMic, IconMicOff, IconPen, IconPin, IconScreen, IconUserPlus, IconUsers, IconVideo } from '@/components/ui/Icons';
import { toolbarInnerSize } from '@/lib/sideWindowGeometry';
import { closeSideWindow, openSideWindow, sideWindow, SideWindowPortal, useSideWindows } from './shareSideWindows';
import { sortRoster } from '@/lib/classSlots';
import { filterPeople } from '@/lib/peopleSearch';
import { floatInsets, useFloatDrag, type FloatPos } from './FloatingPanel';
import { whiteboardShareDockPos } from '@/lib/floatGeometry';
import { focusLabel } from '@/lib/focusStatus';
import { controlUrl, copyParentStyles, mountIn, waitForWindow } from './shareWindowDom';
import { DrawOverlay, useShareDrawing } from './ShareDrawing';
import { AnnotateTools } from './AnnotateTools';
import { useTeacherInk } from './TeacherInk';
import { admitLabel, badgeText, shareToolbarIds, shareToolbarSeparators, type ShareToolbarId } from '@/lib/shareChrome';
import { useTracks, VideoTrack, type TrackReference } from '@livekit/components-react';
import { Track } from 'livekit-client';

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
 * Both are one horizontal pill: grip, Live, mic, camera, videos, then chat,
 * hands, roster, admit, annotate, and Stop. Eco and computer-sound are not
 * on this bar (no teacher control for them in the browser).
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
  /** Asked to draw on the share / drawing now. */
  drawRequested?: boolean;
  drawRequestedAt?: number | null;
  drawing?: boolean;
  /** Heartbeat is late, or LiveKit reports the link lost. Still on the roster. */
  reconnecting?: boolean;
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
  /** Waiting room switch (same setting as the roster and the Windows app). */
  waitingRoomOn?: boolean;
  onWaitingRoom?: (on: boolean) => void;
  teacherMicOn: boolean;
  onToggleTeacherMic: () => void;
  onStopSharing: () => void;
  onMuteStudent: (participantId: string, muted: boolean) => void;
  onMuteAll: (muted: boolean) => void;
  onLowerHand: (participantId: string) => void;
  /** Pin / unpin a student's video in the class panel. */
  onTogglePin?: (participantId: string, pinned: boolean) => void;
  /** Student drawing on the share: who draws now, and the teacher's actions. */
  drawHolderName?: string | null;
  onAllowDraw?: (participantId: string) => void;
  onRevokeDraw?: (participantId?: string) => void;
  onClearDrawing?: () => void;
  /**
   * Drawing preview in the roster: `video` = the shared picture with the
   * strokes (this window is not captured, or is masked); `strokes` = strokes on
   * a dark box (a picture here would be captured again).
   */
  drawPreview?: 'video' | 'strokes';
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
  /** Docked as a column on the right edge (whiteboard mode): panels open to its left. */
  vertical?: boolean;
  /** Label of the stop button (whiteboard mode: "Stop whiteboard"). */
  stopLabel?: string;
  /** End class button (whiteboard mode meeting column). */
  onEndClass?: () => void;
};

type Panel = 'chat' | 'hands' | 'roster' | null;

/** First size of the controls window. The fit effect then matches the pill. */
const OPEN_W = 760;
const OPEN_H = 52;

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
      request = pip.requestWindow({ width: OPEN_W, height: OPEN_H });
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
.tsh-btn[aria-pressed="true"]{background:#1d4ed8;border-color:#93c5fd}
.tsh-btn-danger{color:#f87171;background:transparent}
.tsh-btn-danger:hover{background:rgba(239,68,68,.28);border-color:rgba(239,68,68,.5)}
.tsh-btn[disabled]{opacity:.4;cursor:default}
.tsh-sep{width:1px;height:18px;background:var(--line);flex:0 0 auto}
.tsh-count{position:absolute;top:-4px;right:-4px;min-width:14px;height:14px;padding:0 3px;border-radius:999px;
background:var(--warn);color:#1a1206;font-size:9px;font-weight:800;display:inline-grid;place-items:center}
.tsh-count-blue{background:var(--accent);color:#04122b}
.tsh-focus{background:#dc2626;color:#fff;left:-4px;right:auto}
.tsh-pen-dot{position:absolute;bottom:-2px;left:-2px;width:8px;height:8px;border-radius:99px;background:#38bdf8;box-shadow:0 0 0 2px #0d1219}
.tsh-grip{width:12px;cursor:grab;color:#94a3b8;font-size:10px;letter-spacing:-1px;user-select:none;flex:0 0 auto}
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
.tsh-icon{display:inline-grid;place-items:center;width:28px;height:28px;padding:0;flex-shrink:0}
.tsh-icon.is-on{background:#f59e0b;color:#111;border-color:#f59e0b}
.tsh-icon.is-warn{color:#fcd34d;border-color:#f59e0b;background:transparent}
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
.tsh-inline .tsh-bar{flex-wrap:nowrap;width:max-content;min-width:0;position:static}
.tsh-inline .tsh-panel{width:min(420px,calc(100vw - 16px));max-height:min(280px,45vh)}
.tsh-inline .tsh-chat{height:min(220px,35vh)}
.tsh-vertical{display:flex;flex-direction:row-reverse;align-items:stretch;height:100%;width:auto;max-width:none}
.tsh-vertical .tsh-bar{flex-direction:column;flex-wrap:nowrap;width:auto;min-width:0;height:100%;overflow-y:auto;overflow-x:hidden;position:static;padding:6px 4px;gap:4px}
.tsh-vertical .tsh-btn{height:34px;min-width:34px}
.tsh-vertical .tsh-sep{width:20px;height:1px}
.tsh-vertical .tsh-admit{max-width:34px}
.tsh-vertical .tsh-panel{width:min(340px,40vw);max-height:none;height:100%;border-top:0;border-right:1px solid var(--line)}
.tsh-vertical .tsh-chat{height:auto;flex:1 1 auto;min-height:0}
.tsh-vertical .tsh-tip{white-space:normal;max-width:200px}
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
    waitingRoomOn,
    onWaitingRoom,
    teacherMicOn,
    onToggleTeacherMic,
    onStopSharing,
    onMuteStudent,
    onMuteAll,
    onLowerHand,
    drawHolderName,
    onAllowDraw,
    onRevokeDraw,
    onClearDrawing,
    drawPreview = 'strokes',
    onTogglePin,
    chatUnread,
    chat,
    onChatOpenChange,
    videoMode = false,
    onVideoModeChange,
    notice,
    inline = false,
    focusAlertCount = 0,
    sideWindowsAllowed = false,
    sideWindowsNeedTrust = false,
    teacherCamOn,
    onToggleTeacherCam,
    videosOpen = false,
    onToggleVideos,
  } = props;
  useSideWindows();
  const ink = useTeacherInk();
  const annotateOn = !!ink?.annotating;
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
      // Annotate tools are position:fixed, so they do not grow scrollHeight;
      // the window is opened tall enough to hold the flyout bar.
      const inPanel = !!panel || annotateOn;
      const contentW = inPanel ? Math.max(barW, root.scrollWidth) : barW;
      const contentH = inPanel || notice || sideNotice ? root.scrollHeight : barH || root.scrollHeight;
      let size = toolbarInnerSize({ w: contentW, h: contentH }, { panel: inPanel || !!notice || !!sideNotice });
      if (annotateOn) {
        const verticalTools = ink?.orient === 'vertical';
        size = {
          w: Math.max(size.w, verticalTools ? 420 : 720),
          h: Math.max(size.h, verticalTools ? 520 : 320),
        };
      }
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
  }, [hostWindow, panel, videoMode, waitingCount, notice, sideNotice, annotateOn, ink?.orient]);

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
            <HudDrawing
              holderName={drawHolderName ?? null}
              preview={drawPreview}
              onRevoke={onRevokeDraw}
              onClear={onClearDrawing}
            />
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
              {onWaitingRoom && (
                <button
                  type="button"
                  role="switch"
                  aria-checked={waitingRoomOn !== false}
                  data-testid="hud-waiting-toggle"
                  className={waitingRoomOn !== false ? 'tsh-btn is-warn' : 'tsh-btn'}
                  onClick={() => onWaitingRoom(waitingRoomOn === false)}
                  title={waitingRoomOn !== false ? 'Waiting room on: click to let students in directly' : 'Direct entry: click to turn the waiting room on'}
                >
                  {waitingRoomOn !== false ? 'Waiting room' : 'Direct entry'}
                </button>
              )}
            </div>
            {students.length === 0 ? (
              <p className="tsh-empty">No students yet.</p>
            ) : shownStudents.length === 0 ? (
              <p className="tsh-empty">No student matches “{rosterQuery.trim()}”.</p>
            ) : (
              shownStudents.map((s) => {
                const focus = focusLabel(s.focus, s.focusIphone);
                return (
                  <div
                    className={s.handRaised || s.drawRequested || s.drawing ? 'tsh-person is-raised' : 'tsh-person'}
                    key={s.id}
                    title={s.displayName}
                  >
                    {(s.drawing || s.drawRequested) && (
                      <span className="tsh-hand" title={s.drawing ? 'Drawing on your screen' : 'Asks to draw'} aria-label={s.drawing ? 'Drawing' : 'Asks to draw'}>
                        <IconPen size={12} />
                      </span>
                    )}
                    {s.handRaised && (
                      <span className="tsh-hand" title="Hand raised" aria-label="Hand raised">
                        <IconHand size={12} />
                      </span>
                    )}
                    <Avatar name={s.displayName} size="xs" />
                    <span className="tsh-person-name">{s.displayName}</span>
                    {s.sid ? <span className="tsh-person-sub">{s.sid}</span> : s.gradeDivision ? <span className="tsh-person-sub">{s.gradeDivision}</span> : null}
                    {focus ? <span className="tsh-chip tsh-chip-muted" title={focus}>{focus}</span> : null}
                    {s.reconnecting ? <span className="tsh-chip" title="Reconnecting">Reconnecting</span> : null}
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
                    {s.drawing && onRevokeDraw ? (
                      <button type="button" className="tsh-btn is-warn" onClick={() => onRevokeDraw(s.id)} title={`Stop ${s.displayName} drawing and clear the drawing`}>
                        Revoke
                      </button>
                    ) : s.drawRequested && onAllowDraw ? (
                      <>
                        <button type="button" className="tsh-btn is-on" data-testid="hud-draw-allow" onClick={() => onAllowDraw(s.id)} title={`Let ${s.displayName} draw`}>
                          Allow
                        </button>
                        {onRevokeDraw && (
                          <button type="button" className="tsh-btn" data-testid="hud-draw-deny" onClick={() => onRevokeDraw(s.id)} title={`Turn down ${s.displayName}'s request to draw`}>
                            Deny
                          </button>
                        )}
                      </>
                    ) : null}
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

  const toolbarIds = shareToolbarIds({
    video: !!onVideoModeChange,
    videos: !!onToggleVideos,
    annotate: true,
  });
  const sepBefore = new Set(shareToolbarSeparators(toolbarIds).map((s) => s.before));
  const drawAsk = students.filter((s) => s.drawRequested && !s.drawing).length;
  const chatShown = panel === 'chat' || !!chatWin;
  const rosterShown = panel === 'roster' || !!rosterWin;
  const admitText = admitLabel(waiting.length, waiting[0]?.displayName);
  const shareControl = (id: ShareToolbarId): ReactNode => {
    switch (id) {
      case 'grip':
        return (
          <span className="tsh-grip" title="Drag" aria-hidden>
            ⋮⋮
          </span>
        );
      case 'live':
        return <span className="tsh-live">Live</span>;
      case 'mic':
        return (
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
        );
      case 'cam':
        return onToggleTeacherCam ? (
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
        ) : null;
      case 'videos':
        return onToggleVideos ? (
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
        ) : null;
      case 'video':
        return onVideoModeChange ? (
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
        ) : null;
      case 'chat':
        return (
          <button
            type="button"
            className="tsh-btn"
            aria-pressed={chatShown}
            onClick={() => toggleSide('chat')}
            aria-label={chatShown ? 'Close chat' : 'Open chat'}
            title={chatShown ? 'Close chat' : 'Open chat'}
          >
            <IconChat size={14} />
            {chatUnread > 0 && !chatShown ? <span className="tsh-count">{badgeText(chatUnread)}</span> : null}
          </button>
        );
      case 'hands':
        return (
          <button
            type="button"
            className="tsh-btn"
            aria-pressed={panel === 'hands'}
            onClick={() => (sideWindowsAllowed && !inline ? toggleSide('roster') : togglePanel('hands'))}
            aria-label="Raised hands"
            title="Raised hands (listed first in the roster)"
          >
            <IconHand size={14} />
            {hands.length > 0 && panel !== 'hands' ? <span className="tsh-count">{badgeText(hands.length)}</span> : null}
          </button>
        );
      case 'people':
        return (
          <button
            type="button"
            className="tsh-btn"
            aria-pressed={rosterShown}
            onClick={() => toggleSide('roster')}
            aria-label={rosterShown ? 'Close roster' : 'Open roster'}
            title={drawAsk ? `Roster: ${drawAsk} asking to draw` : 'Roster'}
          >
            <IconUsers size={14} />
            {waitingCount > 0 && !rosterShown ? <span className="tsh-count">{badgeText(waitingCount)}</span> : null}
            {focusAlertCount > 0 ? (
              <span className="tsh-count tsh-focus" data-testid="tsh-focus-alert" title={`${focusAlertCount} left fullscreen`}>
                ⛶{badgeText(focusAlertCount)}
              </span>
            ) : null}
            {drawAsk > 0 ? <span className="tsh-pen-dot" aria-hidden /> : null}
          </button>
        );
      case 'admit':
        return (
          <button
            type="button"
            className={waiting.length > 0 ? 'tsh-btn tsh-icon is-warn' : 'tsh-btn tsh-icon'}
            disabled={waiting.length === 0}
            onClick={() => (waiting.length > 1 ? onAdmitAll?.() : waiting[0] && onAdmit?.(waiting[0].id))}
            aria-label={admitText}
            title={admitText}
          >
            <IconUserPlus size={14} />
          </button>
        );
      case 'annotate':
        return (
          <button
            type="button"
            className="tsh-btn"
            aria-pressed={annotateOn}
            onClick={() => ink?.setAnnotating(!annotateOn)}
            aria-label={annotateOn ? 'Stop annotating' : 'Annotate'}
            title={
              annotateOn
                ? 'Stop annotating (removes your marks)'
                : 'Annotate the shared picture. Students see the marks.'
            }
          >
            <IconPen size={14} />
          </button>
        );
      case 'stop':
        return (
          <button
            type="button"
            className="tsh-btn tsh-btn-danger"
            data-testid="hud-stop"
            onClick={onStopSharing}
            title={props.stopLabel ?? 'Stop sharing'}
            aria-label={props.stopLabel ?? 'Stop sharing screen'}
          >
            <IconScreen size={14} />
            Stop
          </button>
        );
      default:
        return null;
    }
  };

  const tree = (
    <div
      ref={rootRef}
      className={props.vertical ? 'tsh tsh-inline tsh-vertical' : inline ? 'tsh tsh-inline' : !panel && !notice && !sideNotice && !annotateOn ? 'tsh tsh-fill' : 'tsh'}
      role="region"
      aria-label="Share controls"
    >
      <style>{HUD_CSS}</style>
      <div className="tsh-sr" aria-live="polite">
        {waitingLabel}
      </div>
      <div className="tsh-bar" role="toolbar" aria-label="Share tools" data-testid="share-toolbar">
        {toolbarIds.map((id) => (
          <Fragment key={id}>
            {sepBefore.has(id) ? <span className="tsh-sep" aria-hidden /> : null}
            {shareControl(id)}
          </Fragment>
        ))}
      </div>
      {notice || sideNotice ? <div className="tsh-tip">{sideNotice || notice}</div> : null}

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
          {rosterBody}
        </div>
      )}

      <AnnotateTools
        requests={students.filter((s) => s.drawRequested && !s.drawing).map((s) => ({ id: s.id, displayName: s.displayName }))}
        drawers={students.filter((s) => !!s.drawing).map((s) => ({ id: s.id, displayName: s.displayName }))}
        onAllow={onAllowDraw}
        onDeny={onRevokeDraw}
        onClearStudents={onClearDrawing}
      />
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
  action,
  avoidLeft = 0,
}: {
  children: ReactNode;
  hint?: string;
  compact?: boolean;
  /** Extra header control (e.g. allow multi-monitor floating controls). */
  action?: ReactNode;
  /** Re-open the floating window (only offered for window/tab captures). */
  onPopOut?: () => void;
  /**
   * While the whiteboard is shown, keep this dock to the right of the tool
   * column and remember that spot separately from the share-mode dock.
   */
  avoidLeft?: number;
}) {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const defaultPos = useCallback((): FloatPos => {
    if (avoidLeft > 0 && typeof window !== 'undefined') {
      const el = paneRef.current;
      const w = el?.offsetWidth || 280;
      const h = el?.offsetHeight || 44;
      return whiteboardShareDockPos({ w, h }, { w: window.innerWidth, h: window.innerHeight }, floatInsets().top, avoidLeft);
    }
    return { x: 12, y: 72 };
  }, [avoidLeft]);
  const { pos, handleProps } = useFloatDrag({
    id: avoidLeft > 0 ? 'share_controls_wb' : 'share_controls_v2',
    paneRef,
    defaultPos,
    extraInsets: avoidLeft > 0 ? () => ({ left: avoidLeft }) : undefined,
    insetKey: avoidLeft > 0 ? `wb-${avoidLeft}` : 'dock',
  });
  const fallback = avoidLeft > 0 ? { x: avoidLeft + 8, y: 72 } : { x: 12, y: 72 };
  return (
    <div
      ref={paneRef}
      className="share-inline-dock"
      data-testid="share-inline-dock"
      style={pos ? { left: pos.x, top: pos.y } : { left: fallback.x, top: fallback.y }}
      role="region"
      aria-label="Share controls (in this tab)"
      {...handleProps}
    >
      {children}
      {(action || onPopOut) && (
        <div className="share-inline-actions" data-no-drag>
          {action}
          {onPopOut && (
            <button type="button" className="share-inline-btn" onClick={onPopOut}>
              Pop out
            </button>
          )}
        </div>
      )}
      {hint ? <p className="share-inline-hint">{hint}</p> : null}
    </div>
  );
}


/**
 * Share controls → Roster: what students draw, with Clear / Revoke. The
 * shared picture is shown only where this window is not captured (or masked).
 */
function HudDrawing({
  holderName,
  preview,
  onRevoke,
  onClear,
}: {
  holderName: string | null;
  preview: 'video' | 'strokes';
  onRevoke?: (participantId?: string) => void;
  onClear?: () => void;
}) {
  const d = useShareDrawing();
  const tracks = useTracks([{ source: Track.Source.ScreenShare, withPlaceholder: false }], { onlySubscribed: false });
  const mine = tracks.find((t) => t.participant.isLocal && t.publication?.track);
  if (!d || (!d.strokes.length && !holderName)) return null;
  const aspect = typeof window !== 'undefined' && window.screen?.height ? window.screen.width / window.screen.height : 16 / 9;
  return (
    <div className="tsh-draw" style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span className="tsh-panel-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <IconPen size={12} /> {holderName ? `${holderName} ${holderName.includes(', ') ? 'are' : 'is'} drawing` : 'Drawing'}
        </span>
        <span style={{ flex: 1 }} />
        {onClear && d.strokes.length > 0 && (
          <button type="button" className="tsh-btn" onClick={onClear}>
            Clear drawing
          </button>
        )}
        {holderName && onRevoke && (
          <button type="button" className="tsh-btn is-warn" onClick={() => onRevoke()}>
            Revoke
          </button>
        )}
      </div>
      <div className="draw-preview" style={{ aspectRatio: preview === 'video' && mine ? undefined : String(aspect) }}>
        {preview === 'video' && mine ? <VideoTrack trackRef={mine as TrackReference} /> : null}
        <DrawOverlay aspect={preview === 'video' && mine ? undefined : aspect} interactive={false} />
      </div>
    </div>
  );
}

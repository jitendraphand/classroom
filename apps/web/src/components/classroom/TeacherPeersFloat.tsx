'use client';

/**
 * Teacher's floating student-video panel (sampled cameras, pins, speaker
 * priority) and its tiles. (Split out of ClassroomRoom.tsx.)
 */
import { selfTileLabel } from '@/lib/rosterLabels';
import { useRoomContext } from '@livekit/components-react';
import { Track, RoomEvent, VideoQuality, type Participant } from 'livekit-client';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { MEETING_BAR_PX } from '@/lib/shareChrome';
import { floatInsets, useFloatDrag, readFloatPref, writeFloatPref, type FloatPos } from './FloatingPanel';
import {
  VIDEO_PANEL_MIN_W,
  WB_TOOL_CLEAR_PX,
  clampVideoPanelSize,
  parseStoredPos,
  parseStoredSize,
  placeWhiteboardVideo,
  tilesInPane,
  videoPanelSizeFromDrag,
  type FloatRect,
  type VideoPanelClampOpts,
} from '@/lib/floatGeometry';
import { selectTeacherVideos, videoHidden } from '@/lib/droppedVideos';
import { Avatar } from '@/components/ui/Avatar';
import { IconPin } from '@/components/ui/Icons';
import { pickTiles, activeStickySpeakers, studentCapForSlots, type PanelSlots } from '@/lib/classSlots';
import { cn } from '@/lib/cn';
import { SideWindowPortal } from './shareSideWindows';
import {
  PEER_WIN_TILE_W,
  TILE_CONNECT_MS,
  blankTileKind,
  peerWindowGrid,
  peerWindowTileCount,
  peerWindowTileWForWidth,
} from '@/lib/peerWindow';
import { panelShown } from '@/lib/camOnDemand';
import { isTeacherParticipant } from './participantRoles';

/**
 * One student tile as it appears today: the 16:9 video area of the students
 * float at its single-tile width (~372px pane → ~354×199 content).
 * 2 and 4 are one column (2 or 4 rows). 6 is two columns × 3 rows.
 * The window grows with that grid and only shrinks a tile when the stack would leave the screen.
 */
export const PEER_TILE_W = 354;

export const PEER_TILE_H = 199;

export const PEER_TOP_RESERVE = 152;

/** Gap between the docked Class panel and the stage edges. */
export const PEER_DOCK_MARGIN = 8;

/**
 * Below this stage width the expanded Class panel docks as a top band (stage
 * below it) instead of a left column, and is limited to about half the stage
 * height, so a phone-width stage keeps usable room.
 */
export const PEER_DOCK_NARROW_W = 640;

export const PEER_DOCK_NARROW_MAX_H = 0.5;

/** Wide stages: the expanded column never takes more than this share of the stage width. */
export const PEER_DOCK_MAX_W = 0.45;

/** Above the teacher dock. The share bar is no longer in this page. */
export const PEER_BOTTOM_RESERVE = 120;

export function peerFloatLayout(
  slots: 2 | 4 | 6,
  vw: number,
  vh: number,
  availH?: number,
  availW?: number
) {
  const cols = slots === 6 ? 2 : 1;
  const rows = slots === 2 ? 2 : slots === 4 ? 4 : 3;
  const header = 34;
  const pad = 16;
  const gap = 6;
  const border = 2;
  const bottomReserve = PEER_BOTTOM_RESERVE;
  const maxPaneW = availW !== undefined ? Math.max(200, availW) : Math.max(200, vw - 16);
  const maxPaneH =
    availH !== undefined ? Math.max(180, availH) : Math.max(180, vh - PEER_TOP_RESERVE - bottomReserve);
  const scale = Math.min(
    1,
    (maxPaneW - pad - border - gap * (cols - 1)) / (PEER_TILE_W * cols),
    (maxPaneH - header - pad - gap * (rows - 1)) / (PEER_TILE_H * rows)
  );
  const tileW = Math.max(112, Math.floor(PEER_TILE_W * scale));
  const tileH = Math.max(63, Math.floor((tileW * 9) / 16));
  const paneW = border + pad + cols * tileW + gap * (cols - 1);
  const paneH = header + pad + rows * tileH + gap * (rows - 1);
  return { cols, rows, tileW, tileH, paneW, paneH, gap };
}

/** Board rectangle the compact whiteboard video must stay inside (below the header, above the footer). */
export function whiteboardVideoBoard(vw: number, vh: number): FloatRect {
  const insets = typeof document === 'undefined' ? { top: 0, right: 0, bottom: 0, left: 0 } : floatInsets();
  const top = insets.top;
  // The footer is hidden while the board is open. Keep the panel left of the meeting bar.
  const bottom = Math.max(insets.bottom, 8);
  const right = Math.max(insets.right, MEETING_BAR_PX);
  return { x: 0, y: top, w: Math.max(200, vw - right), h: Math.max(160, vh - top - bottom) };
}

export const EMPTY_DROPPED: ReadonlyMap<string, number> = new Map();

export function TeacherPeersFloat({
  roomCode,
  teacherIdentities,
  visibleIdentities,
  selfName,
  selfStream,
  onSlotsChange,
  slots: slotsProp,
  dock = null,
  minLeft = 0,
  whiteboard = false,
  sharing = false,
  onDockSpace,
  focusAlerts = {},
  pinnedIdentities = [],
  onTogglePin,
  portalWindow = null,
  onShownChange,
  embedHost = null,
  videosHidden = false,
  droppedStudents = EMPTY_DROPPED,
  liveRoster = null,
  spotlightIdentity = null,
}: {
  /** Panel visibility to the teacher (drives student cameras on demand). */
  onShownChange?: (shown: boolean) => void;
  /** Hide the in-tab panel (meeting bar / share pill "student videos" toggle). */
  videosHidden?: boolean;
  /**
   * Whiteboard side column. When set, the pane is portaled here instead of
   * floating. A separate videos window (portalWindow) still wins.
   */
  embedHost?: HTMLElement | null;
  /**
   * While sharing: render the panel inside this separate window (beside the
   * share toolbar) instead of the classroom tab. Same tiles, pins, rotation.
   */
  portalWindow?: Window | null;
  /** LiveKit identity → "Left fullscreen" / "Switched away". */
  focusAlerts?: Record<string, string>;
  /** Students the teacher pinned (oldest first): they keep a tile, bypassing rotation. */
  pinnedIdentities?: string[];
  /** Pin / unpin a student from their tile. */
  onTogglePin?: (identity: string, pinned: boolean) => void;
  roomCode: string;
  teacherIdentities: string[];
  visibleIdentities: string[];
  selfName: string;
  selfStream: MediaStream | null;
  /**
   * Roster drop times (identity → moment the grace already elapsed). The
   * mosaic, the floating panel and the sample selection all use this set.
   */
  droppedStudents?: ReadonlyMap<string, number>;
  /** Admitted students. Null until the roster has loaded. */
  liveRoster?: ReadonlySet<string> | null;
  /** Keep this camera subscribed even when it is not one of the mosaic tiles. */
  spotlightIdentity?: string | null;
  /** Student-camera count that fills this window (tiles minus the teacher). */
  onSlotsChange?: (studentSlots: number) => void;
  /** Panel size chosen by the room (synced with the server student cap). */
  slots?: PanelSlots | null;
  /**
   * Stage rectangle (viewport px). The panel docks to the stage's top-left
   * corner (no dragging) and reports the room it needs via onDockSpace so the
   * stage makes space instead of being covered: a top band when minimized, a
   * left column when expanded (a top band on narrow stages). While sharing it
   * starts minimized each share; otherwise the teacher's saved choice holds.
   */
  dock?: { top: number; left: number; width: number; height: number } | null;
  /** Floating: keep the panel right of this x (whiteboard tool column). */
  minLeft?: number;
  /**
   * Whiteboard is open: float a compact 2-tile pane (separate from the docked
   * class panel's size). 4/6 still grows it; the class camera cap changes only
   * when the teacher clicks 2/4/6.
   */
  whiteboard?: boolean;
  /** Teacher is screen sharing: the docked panel starts minimized each share. */
  sharing?: boolean;
  onDockSpace?: (space: { left: number; top: number }) => void;
}) {
  const room = useRoomContext();
  const teacherSet = useMemo(() => new Set(teacherIdentities), [teacherIdentities]);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const sizeRef = useRef({ w: 372, h: 250 });
  const stickySpeakersRef = useRef<Set<string>>(new Set());
  const resizeDrag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    w: number;
    h: number;
    key: string;
  } | null>(null);
  /** identity → last time heard speaking (sticky pins expire, see activeStickySpeakers). */
  const lastSpokeRef = useRef<Map<string, number>>(new Map());
  const seenCamsRef = useRef<Set<string>>(new Set());
  const mosaicPoolRef = useRef<string[]>([]);
  const lastRotationTickRef = useRef(0);
  const [slotCount, setSlotCount] = useState<2 | 4 | 6>(() => {
    try {
      const v = sessionStorage.getItem(`peers_slots_${roomCode.toUpperCase()}`);
      if (v === '2' || v === '4' || v === '6') return Number(v) as 2 | 4 | 6;
    } catch {
      /* ignore */
    }
    return 4;
  });
  useEffect(() => {
    if (slotsProp && slotsProp !== slotCount) setSlotCount(slotsProp);
    // Only follow the room's value when it changes. Does not touch the
    // whiteboard's own tile count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotsProp]);
  // Whiteboard opens at 2 tiles. Growing to 4/6 is for this open only; the
  // next open starts compact again and does not rewrite the docked panel.
  const [wbSlots, setWbSlots] = useState<2 | 4 | 6>(2);
  const [wbEpoch, setWbEpoch] = useState(whiteboard);
  if (whiteboard !== wbEpoch) {
    setWbEpoch(whiteboard);
    if (whiteboard) setWbSlots(2);
  }
  const activeSlots: 2 | 4 | 6 = whiteboard ? wbSlots : slotCount;
  const [minimized, setMinimized] = useState(() => {
    try {
      return sessionStorage.getItem(`peers_min_${roomCode.toUpperCase()}`) === '1';
    } catch {
      return false;
    }
  });
  // Docked in the stage corner by default (the stage reserves its space).
  // Dragging the header floats it anywhere; Dock / double-click re-docks.
  const [floating, setFloating] = useState(() => readFloatPref('class_panel.floating') === '1');
  useEffect(() => {
    writeFloatPref('class_panel.floating', floating ? '1' : '0');
  }, [floating]);
  const portal = !!portalWindow && !portalWindow.closed;
  const docked = !!dock && !floating && !portal;
  const sharingDock = docked && sharing;
  // Minimized state during a share. Starts collapsed at every share; the
  // teacher's saved (non-share) minimized preference is untouched.
  const [shareMinimized, setShareMinimized] = useState(true);
  useEffect(() => {
    if (sharingDock) setShareMinimized(true);
  }, [sharingDock]);
  const isMin = portal ? false : sharingDock ? shareMinimized : minimized;
  const narrowDock = !!dock && dock.width < PEER_DOCK_NARROW_W;
  // Cameras on demand: report shown / minimized (incl. an OS-minimized popup).
  const [portalHidden, setPortalHidden] = useState(false);
  useEffect(() => {
    if (!portal || !portalWindow) {
      setPortalHidden(false);
      return;
    }
    const doc = portalWindow.document;
    const on = () => setPortalHidden(doc.visibilityState === 'hidden');
    on();
    doc.addEventListener('visibilitychange', on);
    return () => doc.removeEventListener('visibilitychange', on);
  }, [portal, portalWindow]);
  const shown = !videosHidden && panelShown({ minimized: isMin, portalHidden });
  const onShownRef = useRef(onShownChange);
  onShownRef.current = onShownChange;
  useEffect(() => {
    // Debounced: a quick minimize/restore does not bounce every camera.
    const t = window.setTimeout(() => onShownRef.current?.(shown), shown ? 0 : 1500);
    return () => window.clearTimeout(t);
  }, [shown]);
  const [rotationTick, setRotationTick] = useState(0);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [stickyVersion, setStickyVersion] = useState(0);
  const [tick, setTick] = useState(0);
  const [viewport, setViewport] = useState({ w: 1400, h: 900 });
  const manualKey = whiteboard ? 'class_panel_wb_manual' : sharing ? 'class_panel_share_manual' : 'class_panel_manual';
  const [manualSize, setManualSize] = useState<{ w: number; h: number } | null>(null);

  const dockAvailH = dock
    ? Math.max(0, (narrowDock ? dock.height * PEER_DOCK_NARROW_MAX_H : dock.height) - 2 * PEER_DOCK_MARGIN)
    : undefined;
  const dockAvailW = dock
    ? Math.max(0, (narrowDock ? dock.width : dock.width * PEER_DOCK_MAX_W) - 2 * PEER_DOCK_MARGIN)
    : undefined;
  const wbPlaced = useMemo(() => {
    if (!whiteboard || activeSlots !== 2) return null;
    return placeWhiteboardVideo(
      parseStoredPos(readFloatPref('class_panel_wb')),
      parseStoredSize(readFloatPref('class_panel_wb_size')),
      whiteboardVideoBoard(viewport.w, viewport.h)
    );
  }, [whiteboard, activeSlots, viewport.w, viewport.h]);
  const layout = useMemo(() => {
    if (wbPlaced) {
      const tiles = tilesInPane(wbPlaced.w, wbPlaced.h, 1, 2);
      return {
        cols: 1,
        rows: 2,
        tileW: tiles.tileW,
        tileH: tiles.tileH,
        paneW: wbPlaced.w,
        paneH: wbPlaced.h,
        gap: 6,
      };
    }
    return peerFloatLayout(activeSlots, viewport.w, viewport.h, dockAvailH, dockAvailW);
  }, [wbPlaced, activeSlots, viewport.w, viewport.h, dockAvailH, dockAvailW]);
  const embedLayout = !!embedHost && !portal;
  // Floating panel in whiteboard, share (docked, floated, or the videos window)
  // and whenever the class panel itself is undocked. The docked class grid
  // keeps the 2/4/6 preset until the teacher floats it.
  const allowResize = !isMin && !embedLayout && (whiteboard || sharing || floating || portal);
  const panelClampOpts: VideoPanelClampOpts = {
    insets: (() => {
      const base = floatInsets();
      return {
        top: base.top,
        right: Math.max(base.right, whiteboard ? MEETING_BAR_PX : 0),
        bottom: base.bottom,
        left: Math.max(base.left, whiteboard ? WB_TOOL_CLEAR_PX : 0),
      };
    })(),
  };
  const clampedManual =
    allowResize && manualSize ? clampVideoPanelSize(manualSize, viewport, panelClampOpts) : null;
  const manualTiles =
    clampedManual != null ? tilesInPane(clampedManual.w, clampedManual.h, layout.cols, layout.rows) : null;
  const view =
    clampedManual && manualTiles
      ? {
          cols: layout.cols,
          rows: layout.rows,
          gap: layout.gap,
          tileW: manualTiles.tileW,
          tileH: manualTiles.tileH,
          paneW: clampedManual.w,
          paneH: clampedManual.h,
        }
      : layout;
  sizeRef.current = isMin
    ? { w: 168, h: 36 }
    : { w: view.paneW, h: view.paneH };

  const defaultPos = useCallback((): FloatPos => {
    if (whiteboard && typeof window !== 'undefined') {
      const placed = placeWhiteboardVideo(null, null, whiteboardVideoBoard(window.innerWidth, window.innerHeight));
      return { x: placed.x, y: placed.y };
    }
    const h = sizeRef.current.h;
    return { x: 12, y: Math.max(PEER_TOP_RESERVE, window.innerHeight - h - PEER_BOTTOM_RESERVE) };
  }, [whiteboard]);

  const { pos, reclamp, moveTo, handleProps } = useFloatDrag({
    // Separate key so the docked panel's left-side position is not reused on the board.
    id: whiteboard ? 'class_panel_wb' : 'class_panel',
    paneRef,
    defaultPos,
    // Dragging the docked panel pulls it out to float (the hook starts the
    // drag from where it is drawn, so it does not jump).
    onDragStart: () => setFloating(true),
    extraInsets: whiteboard ? () => ({ left: WB_TOOL_CLEAR_PX, right: MEETING_BAR_PX }) : undefined,
    insetKey: whiteboard ? 'wb' : 'dock',
  });
  const dock_ = useCallback(() => setFloating(false), []);
  const undock = useCallback(() => {
    const r = paneRef.current?.getBoundingClientRect();
    if (r) moveTo({ x: r.left + 24, y: r.top + 24 });
    setFloating(true);
  }, [moveTo]);

  useEffect(() => {
    try {
      sessionStorage.setItem(`peers_slots_${roomCode.toUpperCase()}`, String(slotCount));
    } catch {
      /* ignore */
    }
  }, [slotCount, roomCode]);

  useEffect(() => {
    try {
      sessionStorage.setItem(`peers_min_${roomCode.toUpperCase()}`, minimized ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [minimized, roomCode]);

  // A 4/6-tile whiteboard pane is remembered so the next open can clamp it
  // back down. The compact 2-tile size is not written (opening always reclamps).
  useEffect(() => {
    if (!whiteboard || isMin || portal || activeSlots === 2) return;
    writeFloatPref('class_panel_wb_size', JSON.stringify({ w: layout.paneW, h: layout.paneH }));
  }, [whiteboard, isMin, portal, activeSlots, layout.paneW, layout.paneH]);

  useEffect(() => {
    const read = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, []);

  useEffect(() => {
    setManualSize(parseStoredSize(readFloatPref(manualKey)));
  }, [manualKey]);

  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const sync = () => {
      const w = el.offsetWidth || view.paneW;
      const h = el.offsetHeight || (isMin ? 36 : view.paneH);
      sizeRef.current = { w, h };
      if (docked) {
        // Expanded: a left column (top band when narrow). Minimized: a thin
        // top band for the pill.
        onDockSpace?.(
          isMin || narrowDock
            ? { left: 0, top: h + 2 * PEER_DOCK_MARGIN }
            : { left: w + 2 * PEER_DOCK_MARGIN, top: 0 }
        );
      } else {
        reclamp();
      }
    };
    sync();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [view.paneW, view.paneH, isMin, docked, narrowDock, reclamp, onDockSpace]);

  useEffect(() => {
    if (!docked) onDockSpace?.({ left: 0, top: 0 });
  }, [docked, onDockSpace]);

  // Random mosaic rotation ~8s among non-sticky students
  useEffect(() => {
    const iv = window.setInterval(() => setRotationTick((n) => n + 1), 8000);
    return () => window.clearInterval(iv);
  }, []);

  const isMicMuted = useCallback((p: Participant) => {
    try {
      if (!p.isMicrophoneEnabled) return true;
      const pub = p.getTrackPublication(Track.Source.Microphone);
      if (!pub) return true;
      if (pub.isMuted) return true;
      return false;
    } catch {
      return true;
    }
  }, []);

  useEffect(() => {
    if (!room) return;
    const onSpeakers = (speakers: Participant[]) => {
      const sticky = stickySpeakersRef.current;
      let changed = false;
      let topSpeaking: string | null = null;

      for (const s of speakers) {
        if (s.isLocal) continue;
        if (isTeacherParticipant(s, teacherSet)) continue;
        if (isMicMuted(s)) {
          if (sticky.delete(s.identity)) changed = true;
          continue;
        }
        // Unmuted + speaking → sticky for STICKY_SPEAKER_TTL_MS after the last word
        lastSpokeRef.current.set(s.identity, Date.now());
        if (!sticky.has(s.identity)) {
          sticky.add(s.identity);
          changed = true;
        }
        if (!topSpeaking) topSpeaking = s.identity;
      }

      // Drop sticky entries that left or are now muted
      if (room) {
        for (const id of Array.from(sticky)) {
          const p = room.remoteParticipants.get(id);
          if (!p || isMicMuted(p)) {
            sticky.delete(id);
            changed = true;
          }
        }
      }

      setSpeakingId(topSpeaking);
      if (changed) setStickyVersion((n) => n + 1);
    };
    room.on(RoomEvent.ActiveSpeakersChanged, onSpeakers);
    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, onSpeakers);
    };
  }, [room, teacherSet, isMicMuted]);

  // Ensure peer cameras in sample are subscribed
  useEffect(() => {
    if (!room) return;
    const ensure = (fromTimer = false) => {
      let changedAny = !fromTimer;
      for (const p of Array.from(room.remoteParticipants.values())) {
        if (isTeacherParticipant(p, teacherSet)) continue;
        // Subscriptions follow the tiles actually shown (effect below);
        // here we only notice cameras that appeared or went away.
        const pub = p.getTrackPublication(Track.Source.Camera);
        if (pub && !seenCamsRef.current.has(pub.trackSid)) {
          seenCamsRef.current.add(pub.trackSid);
          changedAny = true;
        }
        // Keep sticky set in sync with mute state even without speak events
        if (stickySpeakersRef.current.has(p.identity) && isMicMuted(p)) {
          stickySpeakersRef.current.delete(p.identity);
          setStickyVersion((n) => n + 1);
        }
      }
      // The 2 s timer is a safety net: re-render only when it changed something.
      if (changedAny) setTick((n) => n + 1);
    };
    const onEvent = () => ensure(false);
    ensure();
    room.on(RoomEvent.TrackPublished, onEvent);
    room.on(RoomEvent.TrackSubscribed, onEvent);
    room.on(RoomEvent.ParticipantConnected, onEvent);
    room.on(RoomEvent.ParticipantDisconnected, onEvent);
    room.on(RoomEvent.TrackMuted, onEvent);
    room.on(RoomEvent.TrackUnmuted, onEvent);
    room.on(RoomEvent.TrackUnpublished, onEvent);
    room.on(RoomEvent.TrackUnsubscribed, onEvent);
    const iv = window.setInterval(() => ensure(true), 3000);
    return () => {
      room.off(RoomEvent.TrackPublished, onEvent);
      room.off(RoomEvent.TrackSubscribed, onEvent);
      room.off(RoomEvent.ParticipantConnected, onEvent);
      room.off(RoomEvent.ParticipantDisconnected, onEvent);
      room.off(RoomEvent.TrackMuted, onEvent);
      room.off(RoomEvent.TrackUnmuted, onEvent);
      room.off(RoomEvent.TrackUnpublished, onEvent);
      room.off(RoomEvent.TrackUnsubscribed, onEvent);
      window.clearInterval(iv);
    };
  }, [room, teacherSet, visibleIdentities, isMicMuted]);

  void tick;
  void stickyVersion;

  const peerIds = useMemo(() => {
    const tSet = new Set(teacherIdentities);
    const hasLiveCamera = (id: string) => {
      if (!room) return false;
      const p = room.remoteParticipants.get(id);
      if (!p || isTeacherParticipant(p, tSet)) return false;
      const pub = p.getTrackPublication(Track.Source.Camera);
      if (!pub || pub.isMuted) return false;
      // Not subscribed yet (we only subscribe shown tiles) counts as live.
      const media = pub.track?.mediaStreamTrack;
      return !media || media.readyState !== 'ended';
    };
    // Only cameras actually publishing in the sample, minus anyone the roster
    // has dropped. Everyone else stays a blank slot. Same identity cannot
    // appear twice (selectTeacherVideos collapses duplicates on reconnect).
    const pool = selectTeacherVideos(
      visibleIdentities.filter((id) => !tSet.has(id) && !id.startsWith('teacher_') && hasLiveCamera(id)),
      { dropped: droppedStudents, now: Date.now(), liveRoster }
    );
    const pins = pinnedIdentities.filter((id) => pool.includes(id));
    const studentSlots = Math.max(0, activeSlots - 1);
    for (const id of Array.from(lastSpokeRef.current.keys())) {
      if (!stickySpeakersRef.current.has(id)) lastSpokeRef.current.delete(id);
    }
    const sticky = activeStickySpeakers({
      lastSpoke: lastSpokeRef.current,
      now: Date.now(),
      pool,
      pins,
      speakingId,
      studentSlots,
    });

    // Rotation runs among everyone who is not pinned / speaking. Pinned
    // students (teacher), then the active speaker, then sticky speakers take
    // tiles first (see pickTiles in lib/classSlots).
    const rest = pool.filter((id) => !pins.includes(id) && id !== speakingId && !sticky.includes(id));
    const prevMosaic = mosaicPoolRef.current.filter((id) => rest.includes(id));
    const needSlots = Math.max(0, studentSlots - pins.length - sticky.length);
    const membershipChanged =
      prevMosaic.length !== rest.length || prevMosaic.some((id) => !rest.includes(id));
    let mosaic = prevMosaic;
    if (membershipChanged || mosaic.length === 0 || mosaic.length < Math.min(rest.length, needSlots)) {
      const shuffled = [...rest];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      mosaic = shuffled;
      mosaicPoolRef.current = mosaic;
    }
    if (lastRotationTickRef.current !== rotationTick) {
      lastRotationTickRef.current = rotationTick;
      const rotating = mosaic.filter((id) => rest.includes(id));
      for (const id of rest) {
        if (!rotating.includes(id)) rotating.push(id);
      }
      mosaic = rotating.length > 1 ? [...rotating.slice(1), rotating[0]] : rotating;
      mosaicPoolRef.current = mosaic;
    }

    // Never backfill with students who are not publishing a sample camera.
    // The grid still paints `activeSlots` cells; the rest stay blank.
    return pickTiles({
      pool: [...pins, ...(speakingId ? [speakingId] : []), ...sticky, ...mosaic].filter((id) => pool.includes(id)),
      teacherPins: pins,
      speakingId,
      sticky,
      rotation: mosaic,
      studentSlots,
    });
    // `tick` and `stickyVersion` are recompute triggers: the rotation and sticky
    // speakers live in refs this memo reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    visibleIdentities,
    teacherIdentities,
    room,
    speakingId,
    rotationTick,
    activeSlots,
    tick,
    stickyVersion,
    pinnedIdentities,
    droppedStudents,
    liveRoster,
  ]);

  // Bandwidth: subscribe to a student camera only while its tile is shown
  // and the panel is open, and at the lowest layer. A dropped student is
  // unsubscribed entirely (camera and mic) until the roster takes them back.
  const shownKey = isMin ? '' : peerIds.join(',');
  const droppedRef = useRef(droppedStudents);
  droppedRef.current = droppedStudents;
  const liveRosterRef = useRef(liveRoster);
  liveRosterRef.current = liveRoster;
  const spotlightRef = useRef(spotlightIdentity);
  spotlightRef.current = spotlightIdentity;
  useEffect(() => {
    if (!room) return;
    const want = new Set(shownKey ? shownKey.split(',') : []);
    if (spotlightRef.current && !videoHidden(spotlightRef.current, { dropped: droppedRef.current, now: Date.now(), liveRoster: liveRosterRef.current })) {
      want.add(spotlightRef.current);
    }
    const hiddenNow = (identity: string) =>
      videoHidden(identity, { dropped: droppedRef.current, now: Date.now(), liveRoster: liveRosterRef.current });
    const sync = (dropOnly: boolean) => {
      for (const p of Array.from(room.remoteParticipants.values())) {
        if (isTeacherParticipant(p, teacherSet)) continue;
        const drop = hiddenNow(p.identity);
        for (const pub of Array.from(p.trackPublications.values())) {
          try {
            if (drop) {
              if (pub.isSubscribed) pub.setSubscribed(false);
              continue;
            }
            if (dropOnly) continue;
            if (pub.source === Track.Source.Microphone) {
              if (!pub.isSubscribed) pub.setSubscribed(true);
            } else if (pub.source === Track.Source.Camera) {
              const w = want.has(p.identity);
              if (pub.isSubscribed !== w) pub.setSubscribed(w);
              if (w) pub.setVideoQuality(VideoQuality.LOW);
            }
          } catch (e) {
            console.warn('peer cam subscription', e);
          }
        }
      }
    };
    const apply = () => sync(false);
    // A spotlight subscribe must not be undone, but a dropped student's
    // auto-subscribed tracks must still be released.
    const onSubscribed = () => sync(true);
    apply();
    room.on(RoomEvent.TrackPublished, apply);
    room.on(RoomEvent.TrackSubscribed, onSubscribed);
    room.on(RoomEvent.ParticipantConnected, apply);
    return () => {
      room.off(RoomEvent.TrackPublished, apply);
      room.off(RoomEvent.TrackSubscribed, onSubscribed);
      room.off(RoomEvent.ParticipantConnected, apply);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, shownKey, teacherIdentities.join(','), droppedStudents, liveRoster, spotlightIdentity]);

  const cells: Array<string | null> = ['__self__'];
  for (let i = 0; i < activeSlots - 1; i++) cells.push(peerIds[i] ?? null);

  // A newly opened slot may say "Connecting…" for a few seconds. Rotating the
  // sample must not reset that timer, or every tile stays on "Connecting…".
  const [settling, setSettling] = useState(false);
  useEffect(() => {
    setSettling(true);
    const t = window.setTimeout(() => setSettling(false), TILE_CONNECT_MS);
    return () => window.clearTimeout(t);
  }, [activeSlots]);
  const studentsInRoom = room
    ? Array.from(room.remoteParticipants.values()).filter(
        (p) => p.identity.startsWith('student_') && !isTeacherParticipant(p, teacherSet)
      ).length
    : 0;
  const pendingSample = visibleIdentities.filter((id) => {
    if (!id.startsWith('student_') || peerIds.includes(id)) return false;
    const p = room?.remoteParticipants.get(id);
    if (p && isTeacherParticipant(p, teacherSet)) return false;
    if (videoHidden(id, { dropped: droppedStudents, now: Date.now(), liveRoster })) return false;
    return true;
  }).length;

  // Student videos window (during a share): only the tiles actually shown,
  // and the window is resized to exactly fit them (lib/peerWindow).
  const [winTileW, setWinTileW] = useState(PEER_WIN_TILE_W);
  const winCount = peerWindowTileCount({
    slots: activeSlots,
    filled: Math.min(peerIds.length, activeSlots - 1),
    connecting: settling ? pendingSample : 0,
  });
  const winGrid = useMemo(() => peerWindowGrid(winCount, winTileW), [winCount, winTileW]);
  const [paneEl, setPaneEl] = useState<HTMLDivElement | null>(null);
  const setPaneRef = useCallback((el: HTMLDivElement | null) => {
    paneRef.current = el;
    setPaneEl(el);
  }, []);
  const fitRef = useRef<{ w: number; h: number; at: number; tries: number } | null>(null);
  useEffect(() => {
    if (!portal || !portalWindow || !paneEl) return;
    const pw = portalWindow;
    fitRef.current = null;
    const fit = () => {
      if (pw.closed) return;
      const r = paneEl.getBoundingClientRect();
      const w = Math.ceil(r.width);
      const h = Math.ceil(r.height);
      if (!w || !h) return;
      if (Math.abs(pw.innerWidth - w) <= 1 && Math.abs(pw.innerHeight - h) <= 1) {
        fitRef.current = { w, h, at: Date.now(), tries: 0 };
        return;
      }
      const prev = fitRef.current;
      const tries = prev && prev.w === w && prev.h === h ? prev.tries + 1 : 1;
      // The window manager may refuse an exact size: give up after a few tries.
      if (tries > 4) return;
      fitRef.current = { w, h, at: Date.now(), tries };
      const extraW = pw.innerWidth > 0 && pw.outerWidth > 0 ? Math.max(0, pw.outerWidth - pw.innerWidth) : 16;
      const extraH = pw.innerHeight > 0 && pw.outerHeight > 0 ? Math.max(0, pw.outerHeight - pw.innerHeight) : 72;
      try {
        pw.resizeTo(w + extraW, h + extraH);
      } catch {
        /* ignore */
      }
    };
    const onResize = () => {
      const last = fitRef.current;
      // The teacher dragged the window wider / narrower: scale the tiles to the
      // new width; the height then snaps to the tiles.
      if (last && Date.now() - last.at > 700 && Math.abs(pw.innerWidth - last.w) > 8) {
        setWinTileW(peerWindowTileWForWidth(winCount, pw.innerWidth));
        return;
      }
      window.setTimeout(fit, 120);
    };
    fit();
    const t1 = window.setTimeout(fit, 250);
    const t2 = window.setTimeout(fit, 1000);
    pw.addEventListener('load', fit);
    pw.addEventListener('resize', onResize);
    const RO = (pw as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver ?? ResizeObserver;
    const ro = RO ? new RO(() => fit()) : null;
    ro?.observe(paneEl);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      pw.removeEventListener('load', fit);
      pw.removeEventListener('resize', onResize);
      ro?.disconnect();
    };
  }, [portal, portalWindow, paneEl, winGrid.paneW, winGrid.paneH, winCount]);
  if (videosHidden && !portal) return null;
  const L = portal && !clampedManual ? winGrid : view;
  const rawCells = portal ? cells.slice(0, winCount) : cells;
  // No students in the room: drop the empty slots so they never say "Off camera".
  const shownCells = studentsInRoom > 0 ? rawCells : rawCells.filter((id) => id != null);
  let blankCursor = 0;

  const style: CSSProperties = portal
    ? { position: 'relative', left: 0, top: 0, width: 'max-content', height: 'auto', borderRadius: 0, border: 0 }
    : docked && dock
      ? { left: dock.left + PEER_DOCK_MARGIN, top: dock.top + PEER_DOCK_MARGIN }
      : pos
        ? { left: Math.max(minLeft, pos.x), top: pos.y }
        : { left: Math.max(12, minLeft), top: PEER_TOP_RESERVE };
  if (!isMin && !portal) {
    // Preset (2/4/6) or the teacher's dragged size, even when some tiles are blank.
    style.width = view.paneW;
    style.height = view.paneH;
  }
  if (portal && clampedManual) {
    style.width = view.paneW;
    style.height = view.paneH;
  }
  const embed = !!embedHost && !portal;
  if (embed) {
    style.position = 'relative';
    style.left = 0;
    style.top = 0;
    style.width = '100%';
    style.maxWidth = '100%';
    style.height = 'auto';
  }

  // Pointer-up, cancel, and a lost capture all save the same clamped size.
  // Clearing the drag ref first keeps a follow-up lostpointercapture from writing twice.
  const finishResize = (e: ReactPointerEvent<HTMLElement>) => {
    const d = resizeDrag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    resizeDrag.current = null;
    try {
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    const next = videoPanelSizeFromDrag(
      { w: d.w, h: d.h },
      e.clientX - d.x,
      e.clientY - d.y,
      viewport,
      panelClampOpts
    );
    setManualSize(next);
    writeFloatPref(d.key, JSON.stringify(next));
  };

  const pane = (
    <div
      ref={setPaneRef}
      className="peers-float-pane"
      role="region"
      data-slots={activeSlots}
      data-minimized={isMin ? '1' : '0'}
      data-docked={docked ? '1' : '0'}
      style={style}
      aria-label={portal ? 'Student videos' : 'Class videos — drag the top bar to move'}
    >
      <div
        className="peers-float-header"
        {...(portal ? {} : handleProps)}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          if (floating && dock) dock_();
        }}
        title={docked ? 'Drag to float this panel' : 'Drag to move · double-click to dock'}
      >
        <span className="peers-float-grip" aria-hidden>
          ⋮⋮
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1" data-no-drag>
          {!portal && (
            <button
              type="button"
              className="peers-float-slot"
              data-testid="videos-min"
              onClick={() => (sharingDock ? setShareMinimized((v) => !v) : setMinimized((v) => !v))}
              aria-label={isMin ? 'Expand class videos' : 'Minimize class videos'}
              title={isMin ? 'Show student videos' : 'Minimise student videos'}
            >
              {isMin ? `▢ ${peerIds.length + 1}` : '—'}
            </button>
          )}
          {!isMin &&
            ([2, 4, 6] as const).map((n) => (
              <button
                key={n}
                type="button"
                data-testid={`videos-layout-${n}`}
                className={cn('peers-float-slot', activeSlots === n && 'is-on')}
                aria-pressed={activeSlots === n}
                onClick={() => {
                  if (whiteboard) setWbSlots(n);
                  else setSlotCount(n);
                  // A 2/4/6 pick is a preset: drop the dragged size so the
                  // button visibly changes the panel again.
                  setManualSize(null);
                  writeFloatPref(manualKey, null);
                  onSlotsChange?.(studentCapForSlots(n));
                }}
                aria-label={`Show ${n} videos`}
                title={`Show ${n} videos: you + ${n - 1} student${n - 1 === 1 ? '' : 's'}`}
              >
                {n}
              </button>
            ))}
          {dock && !portal && (
            <button
              type="button"
              className="peers-float-slot"
              onClick={floating ? dock_ : undock}
              aria-label={floating ? 'Dock class videos beside the stage' : 'Float class videos'}
              title={floating ? 'Dock beside the stage' : 'Float (drag anywhere)'}
            >
              {floating ? 'Dock' : 'Float'}
            </button>
          )}
        </div>
      </div>
      {!isMin && (
        <div
          className="peers-float-grid"
          data-slots={activeSlots}
          style={{
            gridTemplateRows: `repeat(${L.rows}, ${L.tileH}px)`,
            ...(portal ? { gridTemplateColumns: `repeat(${L.cols}, ${L.tileW}px)` } : {}),
          }}
        >
          {shownCells.map((identity, i) => {
            if (identity === '__self__') {
              const selfTrack =
                selfStream
                  ?.getVideoTracks()
                  .find((track) => track.readyState === 'live' && track.enabled) ?? null;
              return (
                <PeerCamTile
                  key="self"
                  name={selfTileLabel(selfName)}
                  mediaTrack={selfTrack}
                  speaking={false}
                  pinned={false}
                  mirror
                  tileW={L.tileW}
                  tileH={L.tileH}
                />
              );
            }
            if (!identity) {
              const kind = blankTileKind({
                studentsInRoom,
                pendingSample,
                blankIndex: blankCursor,
                settling,
              });
              blankCursor += 1;
              if (kind === 'empty') return null;
              return (
                <div
                  key={`empty-${i}`}
                  className="peers-float-tile"
                  data-empty="1"
                  style={{
                    width: L.tileW,
                    height: L.tileH,
                    display: 'grid',
                    placeItems: 'center',
                    color: '#94a3b8',
                    fontSize: 10,
                    fontWeight: 650,
                  }}
                >
                  {kind === 'connecting' ? 'Connecting…' : 'Off camera'}
                </div>
              );
            }
            let name = identity;
            let mediaTrack: MediaStreamTrack | null = null;
            let speaking = false;
            if (room) {
              const p = room.remoteParticipants.get(identity);
              if (p) {
                name = p.name || p.identity;
                speaking = p.isSpeaking || speakingId === identity;
                const pub = p.getTrackPublication(Track.Source.Camera);
                mediaTrack = pub?.track?.mediaStreamTrack ?? null;
              }
            }
            return (
              <PeerCamTile
                key={identity}
                name={name}
                mediaTrack={mediaTrack}
                speaking={speaking}
                pinned={stickySpeakersRef.current.has(identity) || speakingId === identity}
                teacherPinned={pinnedIdentities.includes(identity)}
                onTogglePin={onTogglePin ? (on) => onTogglePin(identity, on) : undefined}
                tileW={L.tileW}
                tileH={L.tileH}
                alert={focusAlerts[identity]}
              />
            );
          })}
        </div>
      )}
      {allowResize && (
        <div
          role="slider"
          aria-label="Resize videos"
          aria-valuemin={VIDEO_PANEL_MIN_W}
          aria-valuenow={Math.round(view.paneW)}
          data-testid="video-panel-resize"
          data-no-drag
          className="peers-float-resize"
          onPointerDown={(e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            const shown = clampedManual ?? { w: view.paneW, h: view.paneH };
            resizeDrag.current = {
              pointerId: e.pointerId,
              x: e.clientX,
              y: e.clientY,
              w: shown.w,
              h: shown.h,
              key: manualKey,
            };
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              /* pointer capture is missing in a few embedded webviews */
            }
          }}
          onPointerMove={(e) => {
            const d = resizeDrag.current;
            if (!d || d.pointerId !== e.pointerId) return;
            e.preventDefault();
            setManualSize(
              videoPanelSizeFromDrag(
                { w: d.w, h: d.h },
                e.clientX - d.x,
                e.clientY - d.y,
                viewport,
                panelClampOpts
              )
            );
          }}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onLostPointerCapture={finishResize}
        />
      )}
    </div>
  );
  if (portal && portalWindow) {
    return (
      <SideWindowPortal win={portalWindow} title="Student videos">
        {pane}
      </SideWindowPortal>
    );
  }
  if (embedHost) return createPortal(pane, embedHost);
  return pane;
}

export function PeerCamTile({
  name,
  mediaTrack,
  speaking,
  pinned,
  tileW,
  tileH,
  mirror = false,
  alert,
  teacherPinned = false,
  onTogglePin,
}: {
  /** Student left fullscreen / switched away. */
  alert?: string;
  /** The teacher pinned this student (stays in the panel, no rotation). */
  teacherPinned?: boolean;
  onTogglePin?: (pinned: boolean) => void;
  name: string;
  mediaTrack: MediaStreamTrack | null;
  speaking: boolean;
  pinned: boolean;
  tileW: number;
  tileH: number;
  mirror?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (!mediaTrack) {
      el.srcObject = null;
      return;
    }
    el.srcObject = new MediaStream([mediaTrack]);
    void el.play().catch(() => {});
    return () => {
      el.srcObject = null;
    };
  }, [mediaTrack]);

  return (
    <div
      className={cn(
        'peers-float-tile',
        speaking && 'ring-2 ring-brand-400'
      )}
      style={{ width: tileW, height: tileH }}
    >
      {mediaTrack ? (
        <video
          ref={videoRef}
          className={cn('h-full w-full object-cover', mirror && 'video-mirror')}
          autoPlay
          playsInline
          muted
        />
      ) : (
        <div className="flex h-full items-center justify-center bg-gradient-to-br from-surface-3 to-ink-950">
          <Avatar name={name} size="sm" />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/75 to-transparent px-1.5 pb-1 pt-4">
        <span className="flex min-w-0 items-center gap-1 truncate text-[10px] font-medium text-white">
          {teacherPinned && (
            <span className="shrink-0 text-amber-300" aria-label="Pinned" title="Pinned: stays in the panel">
              <IconPin size={10} />
            </span>
          )}
          <span className="truncate">{name}</span>
        </span>
        {pinned && <span className="shrink-0 text-[9px] text-brand-300">Speaking</span>}
      </div>
      {onTogglePin && (
        <button
          type="button"
          className={cn('peer-pin-btn', teacherPinned && 'is-pinned')}
          onClick={() => onTogglePin(!teacherPinned)}
          aria-pressed={teacherPinned}
          aria-label={teacherPinned ? `Unpin ${name}` : `Pin ${name} (keep in the panel)`}
          title={teacherPinned ? 'Unpin (back to rotation)' : 'Pin: keep this student in the panel'}
        >
          <IconPin size={12} />
        </button>
      )}
      {alert && (
        <span
          className="absolute left-1 top-1 rounded-full bg-amber-500 px-1.5 py-0.5 text-[9px] font-bold text-black shadow"
          title={alert}
        >
          {alert}
        </span>
      )}
    </div>
  );
}

'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { cn } from '@/lib/cn';
import {
  clampFloat,
  findFreeSpot,
  fitsAt,
  isDrag,
  parseStoredPos,
  type FloatInsets,
  type FloatPos,
  type FloatRect,
} from '@/lib/floatGeometry';

export type { FloatPos } from '@/lib/floatGeometry';

const STORAGE_PREFIX = 'classroom.float.';
/** Elements that are never a drag start (a tap on them must stay a click). */
const NO_DRAG = 'button, select, input, textarea, a, label, video[controls], [data-no-drag]';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Viewport area floats may occupy: below the element marked
 * `data-float-bound="top"` (teacher header with the raised-hands bar), above
 * `data-float-bound="bottom"` (control bar) and left of
 * `data-float-bound="right"` (phone landscape control rail), so a panel can
 * never hide them.
 */
export function floatInsets(): FloatInsets {
  const insets: FloatInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof document === 'undefined') return insets;
  const vh = window.innerHeight;
  document.querySelectorAll<HTMLElement>('[data-float-bound]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const side = el.dataset.floatBound;
    if (side === 'top') insets.top = Math.max(insets.top, Math.min(vh / 2, r.bottom));
    if (side === 'bottom') insets.bottom = Math.max(insets.bottom, Math.min(vh / 2, vh - r.top));
    // Phone landscape: the student control rail on the right edge.
    if (side === 'right') insets.right = Math.max(insets.right, Math.min(window.innerWidth / 2, window.innerWidth - r.left));
  });
  return insets;
}

/** Fired when a `data-float-bound` bar appears or goes (e.g. the whiteboard meeting bar). */
export const FLOAT_BOUNDS_EVENT = 'classroom:float-bounds';

/** Tell open floats to re-clamp against the current bound bars (Nov 25). */
export function notifyFloatBounds() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(FLOAT_BOUNDS_EVENT));
}

/**
 * Stacking order of the open floats in this page (Nov 27): the one opened or
 * touched last is on top, so a newly opened roster never hides under the
 * chat. z-index 46… stays below the whiteboard meeting bar (110) and toasts.
 */
const FLOAT_Z_BASE = 46;
const floatStack: HTMLElement[] = [];
function raiseFloat(el: HTMLElement) {
  const i = floatStack.indexOf(el);
  if (i >= 0) floatStack.splice(i, 1);
  floatStack.push(el);
  for (let k = floatStack.length - 1; k >= 0; k--) {
    if (!floatStack[k]!.isConnected) floatStack.splice(k, 1);
  }
  floatStack.forEach((f, k) => {
    f.style.zIndex = String(FLOAT_Z_BASE + k);
  });
}

/** The other open floats in this page (to open a new one in a free spot). */
function otherFloatRects(self: HTMLElement | null): FloatRect[] {
  if (typeof document === 'undefined') return [];
  return [...document.querySelectorAll<HTMLElement>('[data-float-pane]')]
    .filter((el) => el !== self)
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height }));
}

function viewportSize() {
  return { w: window.innerWidth, h: window.innerHeight };
}

export function readFloatPref(key: string): string | null {
  try {
    return localStorage.getItem(STORAGE_PREFIX + key);
  } catch {
    return null;
  }
}

export function writeFloatPref(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(STORAGE_PREFIX + key);
    else localStorage.setItem(STORAGE_PREFIX + key, value);
  } catch {
    /* private mode / quota */
  }
}

/**
 * Drag any floating pane by its handle with mouse, pen or touch.
 *
 * - Pointer events + pointer capture; starts only after a 4 px move, so a tap
 *   on the handle stays a tap and buttons/inputs inside never start a drag.
 * - Clamped to the viewport between the header and the control bar, and
 *   re-clamped on resize, orientation change, the on-screen keyboard and pane
 *   size changes. The user's chosen spot is kept separately, so rotating the
 *   phone and back puts the panel where it was.
 * - Remembered per panel in localStorage (`classroom.float.<id>`).
 */
export function useFloatDrag(opts: {
  id: string;
  paneRef: RefObject<HTMLElement | null>;
  defaultPos: () => FloatPos;
  /** Called once when a drag actually starts (e.g. undock the Class panel). */
  onDragStart?: () => void;
  /**
   * Extra clamp insets, merged with `floatInsets()` by max. Held in a ref so
   * the clamp callback stays stable. Use for the whiteboard tool column.
   */
  extraInsets?: () => Partial<FloatInsets>;
  /** Re-read storage and re-clamp when this changes (whiteboard open/close). */
  insetKey?: string;
}) {
  const { id, paneRef } = opts;
  const defaultRef = useRef(opts.defaultPos);
  defaultRef.current = opts.defaultPos;
  const startRef = useRef(opts.onDragStart);
  startRef.current = opts.onDragStart;
  const extraRef = useRef(opts.extraInsets);
  extraRef.current = opts.extraInsets;
  const insetKey = opts.insetKey ?? '';

  const desired = useRef<FloatPos | null>(null);
  const [pos, setPos] = useState<FloatPos | null>(null);
  const [maxH, setMaxH] = useState<number | null>(null);
  const [maxW, setMaxW] = useState<number | null>(null);
  const drag = useRef<{ pointerId: number; px: number; py: number; x: number; y: number; active: boolean } | null>(null);

  const clampNow = useCallback(
    (p: FloatPos): FloatPos => {
      const el = paneRef.current;
      const r = el?.getBoundingClientRect();
      const size = { w: r?.width || 0, h: r?.height || 0 };
      const base = floatInsets();
      const extra = extraRef.current?.() ?? {};
      return clampFloat(p, size, viewportSize(), {
        top: Math.max(base.top, extra.top ?? 0),
        right: Math.max(base.right, extra.right ?? 0),
        bottom: Math.max(base.bottom, extra.bottom ?? 0),
        left: Math.max(base.left, extra.left ?? 0),
      });
    },
    [paneRef]
  );

  const apply = useCallback(() => {
    const want = desired.current;
    const insets = floatInsets();
    const avail = Math.max(120, window.innerHeight - insets.top - insets.bottom - 8);
    setMaxH((prev) => (prev === avail ? prev : avail));
    // Never wider than the room left of the right-hand toolbar (Nov 25).
    const extra = extraRef.current?.() ?? {};
    const availW = Math.max(
      140,
      window.innerWidth - Math.max(insets.left, extra.left ?? 0) - Math.max(insets.right, extra.right ?? 0) - 8
    );
    setMaxW((prev) => (prev === availW ? prev : availW));
    if (!want) return;
    const next = clampNow(want);
    setPos((prev) => (prev && prev.x === next.x && prev.y === next.y ? prev : next));
  }, [clampNow]);

  // Restore (or default) before paint so the panel does not jump. A stored
  // spot from another screen size that no longer fits whole is dropped, and
  // the pane opens where it covers no other open float (Nov 27).
  useIsoLayoutEffect(() => {
    const el = paneRef.current;
    const inMain = !!el && el.ownerDocument === document;
    if (el && inMain) {
      el.dataset.floatPane = id;
      raiseFloat(el);
    }
    const stored = parseStoredPos(readFloatPref(id));
    let want = stored ?? defaultRef.current();
    if (el && inMain) {
      const r = el.getBoundingClientRect();
      const size = { w: r.width, h: r.height };
      const base = floatInsets();
      const extra = extraRef.current?.() ?? {};
      const insets = {
        top: Math.max(base.top, extra.top ?? 0),
        right: Math.max(base.right, extra.right ?? 0),
        bottom: Math.max(base.bottom, extra.bottom ?? 0),
        left: Math.max(base.left, extra.left ?? 0),
      };
      if (size.w && size.h) {
        if (stored && !fitsAt(stored, size, viewportSize(), insets)) want = defaultRef.current();
        want = findFreeSpot(want, size, viewportSize(), otherFloatRects(el), insets);
      }
    }
    desired.current = want;
    apply();
  }, [id, insetKey, apply, paneRef]);

  // Touching a float brings it to the front.
  useEffect(() => {
    const el = paneRef.current;
    if (!el || el.ownerDocument !== document) return;
    const front = () => raiseFloat(el);
    el.addEventListener('pointerdown', front, true);
    // Closed panes drop out of the order by themselves (raiseFloat skips
    // detached ones); a re-render must not remove this one.
    return () => el.removeEventListener('pointerdown', front, true);
  });

  useEffect(() => {
    const onChange = () => apply();
    window.addEventListener('resize', onChange);
    window.addEventListener('orientationchange', onChange);
    const vv = window.visualViewport;
    vv?.addEventListener('resize', onChange);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onChange) : null;
    const observeBounds = () => document.querySelectorAll('[data-float-bound]').forEach((el) => ro?.observe(el));
    if (paneRef.current) ro?.observe(paneRef.current);
    observeBounds();
    // A bound bar mounted later (whiteboard meeting bar): observe it and re-clamp.
    const onBounds = () => {
      observeBounds();
      onChange();
    };
    window.addEventListener(FLOAT_BOUNDS_EVENT, onBounds);
    return () => {
      window.removeEventListener(FLOAT_BOUNDS_EVENT, onBounds);
      window.removeEventListener('resize', onChange);
      window.removeEventListener('orientationchange', onChange);
      vv?.removeEventListener('resize', onChange);
      ro?.disconnect();
    };
  }, [apply, paneRef]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if ((e.target as HTMLElement).closest(NO_DRAG)) return;
      if (drag.current) return;
      const r = paneRef.current?.getBoundingClientRect();
      if (!r) return;
      drag.current = { pointerId: e.pointerId, px: e.clientX, py: e.clientY, x: r.left, y: r.top, active: false };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    },
    [paneRef]
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.pointerId !== e.pointerId) return;
      const dx = e.clientX - d.px;
      const dy = e.clientY - d.py;
      if (!d.active) {
        if (!isDrag(dx, dy)) return;
        d.active = true;
        startRef.current?.();
      }
      e.preventDefault();
      const next = clampNow({ x: d.x + dx, y: d.y + dy });
      desired.current = next;
      setPos(next);
    },
    [clampNow]
  );

  const finish = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.pointerId !== e.pointerId) return;
      drag.current = null;
      try {
        if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (d.active && desired.current) writeFloatPref(id, JSON.stringify(desired.current));
    },
    [id]
  );

  /** Move programmatically (e.g. undock at the current spot). */
  const moveTo = useCallback(
    (p: FloatPos, persist = true) => {
      const next = clampNow(p);
      desired.current = next;
      setPos(next);
      if (persist) writeFloatPref(id, JSON.stringify(next));
    },
    [clampNow, id]
  );

  return {
    pos,
    maxH,
    maxW,
    reclamp: apply,
    moveTo,
    handleProps: {
      'data-drag-handle': '',
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
      onLostPointerCapture: finish,
    },
  };
}

type FloatingPanelProps = {
  title: string;
  /** Stable per-panel id, used for the remembered position. */
  storageKey: string;
  defaultPos: () => FloatPos;
  width?: number;
  height?: number;
  minimizedWidth?: number;
  children: ReactNode;
  badge?: ReactNode;
  className?: string;
  /** Controlled open; when false, render nothing (parent may show dock button). */
  open?: boolean;
  onClose?: () => void;
  /** Start minimized */
  defaultMinimized?: boolean;
  /** Extra no-go margins (e.g. the whiteboard tool column on the left). */
  extraInsets?: () => Partial<FloatInsets>;
};

/**
 * Draggable floating panel (drag by the header) with minimize → compact bar.
 */
export function FloatingPanel({
  title,
  storageKey,
  defaultPos,
  width = 320,
  height = 420,
  minimizedWidth = 160,
  children,
  badge,
  className,
  open = true,
  onClose,
  defaultMinimized = false,
  extraInsets,
}: FloatingPanelProps) {
  if (!open) return null;
  return (
    <FloatingPanelInner
      title={title}
      storageKey={storageKey}
      defaultPos={defaultPos}
      width={width}
      height={height}
      minimizedWidth={minimizedWidth}
      badge={badge}
      className={className}
      onClose={onClose}
      defaultMinimized={defaultMinimized}
      extraInsets={extraInsets}
    >
      {children}
    </FloatingPanelInner>
  );
}

function FloatingPanelInner({
  title,
  storageKey,
  defaultPos,
  width = 320,
  height = 420,
  minimizedWidth = 160,
  children,
  badge,
  className,
  onClose,
  defaultMinimized = false,
  extraInsets,
}: Omit<FloatingPanelProps, 'open'>) {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [minimized, setMinimized] = useState(() => {
    const v = readFloatPref(`${storageKey}.min`);
    if (v === '1') return true;
    if (v === '0') return false;
    return defaultMinimized;
  });

  const { pos, maxH, maxW, handleProps, reclamp } = useFloatDrag({ id: storageKey, paneRef, defaultPos, extraInsets, insetKey: extraInsets ? 'extra' : '' });

  useEffect(() => {
    writeFloatPref(`${storageKey}.min`, minimized ? '1' : '0');
    reclamp();
  }, [minimized, storageKey, reclamp]);

  const style = pos
    ? { left: pos.x, top: pos.y, width: minimized ? minimizedWidth : width }
    : { right: 16, bottom: 100, width: minimized ? minimizedWidth : width };

  return (
    <div
      ref={paneRef}
      className={cn('float-panel', minimized && 'float-panel-minimized', className)}
      style={{
        ...style,
        ...(maxW ? { maxWidth: maxW } : {}),
        height: minimized ? undefined : maxH ? Math.min(height, maxH) : height,
      }}
    >
      <div className="float-panel-header" {...handleProps} title="Drag to move">
        <span className="truncate text-2xs font-semibold text-slate-100">
          <span aria-hidden className="mr-1 text-slate-500">⠿</span>
          {title}
        </span>
        <div className="flex items-center gap-1" data-no-drag>
          {badge}
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] font-bold text-slate-300 hover:bg-white/10"
            onClick={() => setMinimized((v) => !v)}
            aria-label={minimized ? 'Expand panel' : 'Minimize panel'}
          >
            {minimized ? '▢' : '—'}
          </button>
          {onClose && (
            <button
              type="button"
              className="rounded px-1.5 py-0.5 text-[10px] font-bold text-slate-300 hover:bg-white/10"
              onClick={onClose}
              aria-label="Close panel"
            >
              ✕
            </button>
          )}
        </div>
      </div>
      {!minimized && <div className="float-panel-body min-h-0 flex-1">{children}</div>}
    </div>
  );
}

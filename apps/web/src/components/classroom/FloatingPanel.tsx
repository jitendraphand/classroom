'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { cn } from '@/lib/cn';

export type FloatPos = { x: number; y: number };

export function clampFloatPos(x: number, y: number, w: number, h: number): FloatPos {
  const margin = 8;
  const chromeBottom = 96;
  const maxX = Math.max(margin, window.innerWidth - w - margin);
  const maxY = Math.max(margin, window.innerHeight - h - chromeBottom);
  return {
    x: Math.min(maxX, Math.max(margin, x)),
    y: Math.min(maxY, Math.max(margin, y)),
  };
}

export function useDraggableFloat(
  storageKey: string,
  defaultPos: () => FloatPos,
  sizeRef: RefObject<{ w: number; h: number }>
) {
  const [pos, setPos] = useState<FloatPos | null>(null);
  const dragging = useRef(false);
  const origin = useRef({ px: 0, py: 0, x: 0, y: 0 });

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as FloatPos;
        if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
          const sz = sizeRef.current || { w: 186, h: 105 };
          setPos(clampFloatPos(parsed.x, parsed.y, sz.w, sz.h));
          return;
        }
      }
    } catch {
      /* ignore */
    }
    setPos(defaultPos());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  useEffect(() => {
    const onResize = () => {
      setPos((prev) => {
        if (!prev) return prev;
        const sz = sizeRef.current || { w: 186, h: 105 };
        return clampFloatPos(prev.x, prev.y, sz.w, sz.h);
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [sizeRef]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('button, select, input, a, textarea, [data-no-drag]')) return;
      e.preventDefault();
      e.stopPropagation();
      const cur = pos || defaultPos();
      dragging.current = true;
      origin.current = { px: e.clientX, py: e.clientY, x: cur.x, y: cur.y };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [pos, defaultPos]
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - origin.current.px;
      const dy = e.clientY - origin.current.py;
      const sz = sizeRef.current || { w: 186, h: 105 };
      const next = clampFloatPos(origin.current.x + dx, origin.current.y + dy, sz.w, sz.h);
      setPos(next);
    },
    [sizeRef]
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent) => {
      if (!dragging.current) return;
      dragging.current = false;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      setPos((prev) => {
        if (!prev) return prev;
        try {
          sessionStorage.setItem(storageKey, JSON.stringify(prev));
        } catch {
          /* ignore */
        }
        return prev;
      });
    },
    [storageKey]
  );

  return {
    pos,
    setPos,
    dragHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
  };
}

type FloatingPanelProps = {
  title: string;
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
};

/**
 * Draggable floating panel with minimize → compact bar.
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
}: FloatingPanelProps) {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const sizeRef = useRef({ w: width, h: height });
  const [minimized, setMinimized] = useState(() => {
    try {
      const v = sessionStorage.getItem(`${storageKey}_min`);
      if (v === '1') return true;
      if (v === '0') return false;
    } catch {
      /* ignore */
    }
    return defaultMinimized;
  });

  useEffect(() => {
    sizeRef.current = minimized
      ? { w: minimizedWidth, h: 40 }
      : { w: width, h: height };
  }, [minimized, width, height, minimizedWidth]);

  const { pos, dragHandlers } = useDraggableFloat(storageKey, defaultPos, sizeRef);

  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const sync = () => {
      sizeRef.current = { w: el.offsetWidth || width, h: el.offsetHeight || (minimized ? 40 : height) };
    };
    sync();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [minimized, width, height]);

  useEffect(() => {
    try {
      sessionStorage.setItem(`${storageKey}_min`, minimized ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [minimized, storageKey]);

  if (!open) return null;

  const style = pos
    ? { left: pos.x, top: pos.y, width: minimized ? minimizedWidth : width }
    : { right: 16, bottom: 100, width: minimized ? minimizedWidth : width };

  return (
    <div
      ref={paneRef}
      className={cn('float-panel', minimized && 'float-panel-minimized', className)}
      style={{
        ...style,
        height: minimized ? undefined : height,
      }}
      {...dragHandlers}
    >
      <div className="float-panel-header">
        <span className="truncate text-2xs font-semibold text-slate-100">{title}</span>
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

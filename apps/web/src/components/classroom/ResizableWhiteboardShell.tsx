'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

const MIN_W = 320;
const MIN_H = 240;
const MAX_H = 900;

type Size = { w: number; h: number };

/**
 * Teacher whiteboard stage with drag-corner resize; persists to sessionStorage.
 */
export function ResizableWhiteboardShell({
  storageKey,
  children,
  className,
}: {
  storageKey: string;
  children: ReactNode;
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<Size | null>(null);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Size;
        if (typeof parsed.w === 'number' && typeof parsed.h === 'number') {
          setSize({
            w: Math.max(MIN_W, parsed.w),
            h: Math.min(MAX_H, Math.max(MIN_H, parsed.h)),
          });
          return;
        }
      }
    } catch {
      /* ignore */
    }
    // Default: fill parent width, comfortable height
    const parentW = wrapRef.current?.parentElement?.clientWidth || window.innerWidth - 48;
    setSize({
      w: Math.max(MIN_W, Math.min(parentW, 1100)),
      h: Math.min(MAX_H, Math.max(MIN_H, Math.round(window.innerHeight * 0.55))),
    });
  }, [storageKey]);

  const persist = useCallback(
    (next: Size) => {
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* ignore */
      }
    },
    [storageKey]
  );

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || !size) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const start = { ...size };
      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        const parentMax = wrapRef.current?.parentElement?.clientWidth || window.innerWidth - 32;
        const next = {
          w: Math.min(parentMax, Math.max(MIN_W, start.w + (ev.clientX - startX))),
          h: Math.min(MAX_H, Math.max(MIN_H, start.h + (ev.clientY - startY))),
        };
        setSize(next);
      };
      const onUp = (ev: PointerEvent) => {
        target.releasePointerCapture(ev.pointerId);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        setSize((prev) => {
          if (prev) persist(prev);
          return prev;
        });
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [size, persist]
  );

  return (
    <div
      ref={wrapRef}
      className={cn('resizable-wb-shell relative', className)}
      style={
        size
          ? { width: size.w, height: size.h, maxWidth: '100%' }
          : { width: '100%', height: 'min(55dvh, 560px)' }
      }
    >
      <div className="h-full w-full overflow-hidden">{children}</div>
      <div
        className="resizable-wb-handle"
        onPointerDown={onResizePointerDown}
        title="Drag to resize whiteboard"
        aria-label="Resize whiteboard"
        role="separator"
      />
    </div>
  );
}

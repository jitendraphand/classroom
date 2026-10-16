'use client';
/**
 * Viewer-local zoom / pan for the student's screen-share stage (pinch, wheel,
 * drag when zoomed; Reset button). Nothing is sent. The content (video + the
 * drawing overlay) is CSS-transformed together; the overlay measures its own
 * layout box (clientWidth) and maps pointers with getBoundingClientRect, so
 * strokes land where the student touches at any zoom (lib/zoomPan.ts).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ZP_IDENTITY, isZoomed, panBy, pinchZP, wheelFactor, zoomAt, type ZoomPan } from '@/lib/zoomPan';

export function ZoomPanSurface({ children, panWithOneFinger = true }: { children: ReactNode; panWithOneFinger?: boolean }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [t, setT] = useState<ZoomPan>(ZP_IDENTITY);
  const pts = useRef(new Map<number, [number, number]>());
  const drag = useRef<{ x: number; y: number; t: ZoomPan } | null>(null);
  const size = () => ({ w: box.current?.clientWidth ?? 1, h: box.current?.clientHeight ?? 1 });
  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = box.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  // Wheel needs a non-passive listener to stop page zoom / scroll.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const [sx, sy] = local(e);
      const { w, h } = size();
      setT((cur) => zoomAt(cur, wheelFactor(e.deltaY, e.deltaMode), sx, sy, w, h));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div
      ref={box}
      data-testid="zoom-surface"
      className="relative h-full w-full overflow-hidden"
      style={{ touchAction: 'none' }}
      onPointerDownCapture={(e) => {
        pts.current.set(e.pointerId, local(e));
        if (pts.current.size === 1 && panWithOneFinger && isZoomed(t)) drag.current = { x: e.clientX, y: e.clientY, t };
        else drag.current = null;
      }}
      onPointerMove={(e) => {
        const prev = pts.current.get(e.pointerId);
        if (!prev) return;
        const next = local(e);
        const { w, h } = size();
        if (pts.current.size >= 2) {
          const other = [...pts.current.entries()].find(([id]) => id !== e.pointerId)?.[1];
          pts.current.set(e.pointerId, next);
          if (other) setT((cur) => pinchZP(cur, prev, other, next, other, w, h));
          return;
        }
        pts.current.set(e.pointerId, next);
        const d = drag.current;
        if (d) setT(panBy(d.t, e.clientX - d.x, e.clientY - d.y, w, h));
      }}
      onPointerUp={(e) => {
        pts.current.delete(e.pointerId);
        drag.current = null;
      }}
      onPointerCancel={(e) => {
        pts.current.delete(e.pointerId);
        drag.current = null;
      }}
    >
      <div className="absolute inset-0" data-testid="zoom-content" style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.s})`, transformOrigin: '0 0' }}>
        {children}
      </div>
      {isZoomed(t) && (
        <button
          type="button"
          data-testid="zoom-reset"
          onClick={() => setT(ZP_IDENTITY)}
          className="absolute bottom-3 left-3 z-[5] rounded-lg border border-white/20 bg-black/75 px-3 py-1.5 text-xs font-semibold text-white"
        >
          Reset zoom
        </button>
      )}
    </div>
  );
}

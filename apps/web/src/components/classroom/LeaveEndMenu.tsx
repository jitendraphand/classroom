'use client';

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/**
 * Teacher: one "Leave" button that offers both ways out (Nov 26 request):
 * - Leave class: only the teacher leaves; the class keeps running.
 * - End class for everyone: ends it (the caller shows its own confirmation).
 * The two used to be separate buttons one mis-click apart.
 *
 * Plain DOM (no browser-specific APIs): works the same in Chrome, Edge,
 * Firefox and Safari. Closes on Escape, on a click outside, and after a pick.
 */
export function LeaveEndMenu({
  onLeave,
  onEnd,
  placement = 'up',
  triggerClassName,
  triggerStyle,
  children,
  testId = 'leave-end',
}: {
  onLeave: () => void;
  onEnd: () => void;
  /** 'up': opens above the button (bottom toolbar); 'left': beside it (right-hand bar). */
  placement?: 'up' | 'left';
  triggerClassName?: string;
  triggerStyle?: CSSProperties;
  /** Button content (icon, word). */
  children: ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const firstRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    firstRef.current?.focus();
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const menuStyle: CSSProperties =
    placement === 'left'
      ? { position: 'absolute', right: 'calc(100% + 8px)', bottom: 0, zIndex: 200 }
      : { position: 'absolute', right: 0, bottom: 'calc(100% + 8px)', zIndex: 200 };

  return (
    <span ref={wrapRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        data-no-auto-fullscreen
        data-testid={testId}
        className={triggerClassName}
        style={triggerStyle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Leave or end the class"
        title="Leave or end the class"
        onClick={() => setOpen((v) => !v)}
      >
        {children}
      </button>
      {open && (
        <div role="menu" aria-label="Leave or end the class" className="leave-end-menu" style={menuStyle} data-testid={`${testId}-menu`}>
          <button
            ref={firstRef}
            type="button"
            role="menuitem"
            data-no-auto-fullscreen
            className="leave-end-item"
            data-testid={`${testId}-leave`}
            onClick={() => {
              setOpen(false);
              onLeave();
            }}
          >
            <span className="leave-end-title">Leave class</span>
            <span className="leave-end-sub">You leave; the class keeps running</span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-no-auto-fullscreen
            className="leave-end-item is-danger"
            data-testid={`${testId}-end`}
            onClick={() => {
              setOpen(false);
              onEnd();
            }}
          >
            <span className="leave-end-title">End class for everyone</span>
            <span className="leave-end-sub">All students leave; attendance is saved</span>
          </button>
        </div>
      )}
    </span>
  );
}

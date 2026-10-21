'use client';
/**
 * Grouped toolbar (inline styles: runs in the web app and the Windows app).
 * One compact column (or row) of group buttons; the active group's options
 * open in a second column/row next to it. Hover opens (short delay), leaving
 * closes (grace period), tap/click toggles and pins. Escape or a press
 * outside closes. See flyout.ts for the rules.
 */
import { useCallback, useEffect, useReducer, useRef, type CSSProperties, type ReactNode } from 'react';
import { FLYOUT_CLOSED, HOVER_CLOSE_MS, flyoutReduce, hoverOpenDelay, type FlyoutEvent, type FlyoutState } from './flyout';

export function useFlyout() {
  const [state, dispatch] = useReducer(flyoutReduce, FLYOUT_CLOSED);
  const stateRef = useRef<FlyoutState>(state);
  stateRef.current = state;
  const openT = useRef<number | null>(null);
  const closeT = useRef<number | null>(null);
  const lastTouch = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const clear = () => {
    if (openT.current !== null) window.clearTimeout(openT.current);
    if (closeT.current !== null) window.clearTimeout(closeT.current);
    openT.current = closeT.current = null;
  };
  const send = useCallback((e: FlyoutEvent) => dispatch(e), []);
  useEffect(() => () => clear(), []);
  useEffect(() => {
    if (!state.open) return;
    const doc = rootRef.current?.ownerDocument ?? document;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && rootRef.current.contains(e.target)) return;
      dispatch({ t: 'close' });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch({ t: 'close' });
    };
    doc.addEventListener('pointerdown', onDown, true);
    doc.addEventListener('keydown', onKey);
    return () => {
      doc.removeEventListener('pointerdown', onDown, true);
      doc.removeEventListener('keydown', onKey);
    };
  }, [state.open]);

  const groupProps = (g: string) => ({
    onPointerDown: (e: React.PointerEvent) => {
      lastTouch.current = e.pointerType === 'touch' || e.pointerType === 'pen';
    },
    onPointerEnter: (e: React.PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      clear();
      const delay = hoverOpenDelay(stateRef.current);
      if (delay === 0) dispatch({ t: 'enter', g });
      else openT.current = window.setTimeout(() => dispatch({ t: 'enter', g }), delay);
    },
    onPointerLeave: () => {
      if (openT.current !== null) window.clearTimeout(openT.current);
      openT.current = null;
    },
    onClick: () => {
      clear();
      dispatch({ t: 'tap', g, touch: lastTouch.current });
      lastTouch.current = false;
    },
    'aria-expanded': state.open === g,
    'data-flyout-group': g,
  });
  const rootProps = {
    ref: rootRef,
    onPointerEnter: (e: React.PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      if (closeT.current !== null) window.clearTimeout(closeT.current);
      closeT.current = null;
    },
    onPointerLeave: (e: React.PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      if (openT.current !== null) window.clearTimeout(openT.current);
      openT.current = null;
      if (closeT.current !== null) window.clearTimeout(closeT.current);
      closeT.current = window.setTimeout(() => dispatch({ t: 'leave' }), HOVER_CLOSE_MS);
    },
  };
  /** After choosing an option: touch closes the flyout, mouse keeps it while hovering. */
  const pick = () => send({ t: 'pick', touch: lastTouch.current });
  const optionProps = {
    onPointerDown: (e: React.PointerEvent) => {
      lastTouch.current = e.pointerType === 'touch' || e.pointerType === 'pen';
    },
  };
  return { open: state.open, pinned: state.pinned, groupProps, rootProps, optionProps, pick, close: () => send({ t: 'close' }) };
}

export type FlyoutGroup = {
  id: string;
  label: string;
  icon: ReactNode;
  /** Highlight (a tool of this group is selected / the thing is on). */
  active?: boolean;
  danger?: boolean;
  badge?: number;
  /** No options: the button acts directly (e.g. mic toggle). */
  onClick?: () => void;
  disabled?: boolean;
  /** Options shown in the second column/row. */
  content?: ReactNode;
  testId?: string;
  /** Amber outline (admit while someone is waiting). */
  warn?: boolean;
};

export const BAR_BG = '#111827';
export function barBtn(active = false, extra?: CSSProperties): CSSProperties {
  return {
    position: 'relative',
    minWidth: 40,
    height: 40,
    padding: '0 6px',
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.12)',
    background: active ? '#2563eb' : 'rgba(255,255,255,0.06)',
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    touchAction: 'manipulation',
    flex: 'none',
    ...extra,
  };
}

function Badge({ n }: { n?: number }) {
  if (!n) return null;
  return (
    <span style={{ position: 'absolute', top: -5, right: -5, minWidth: 16, height: 16, borderRadius: 8, background: '#f59e0b', color: '#111', fontSize: 10, fontWeight: 800, display: 'grid', placeItems: 'center', padding: '0 3px' }}>
      {n > 9 ? '9+' : n}
    </span>
  );
}

/**
 * `orient` = direction of the main line. `side` = where the options open:
 * 'after' (right of a vertical bar / below a horizontal one) or 'before'.
 */
export function FlyoutBar({
  groups,
  orient = 'vertical',
  side = 'after',
  label,
  head,
  tail,
  style,
  flyout,
}: {
  groups: FlyoutGroup[];
  orient?: 'vertical' | 'horizontal';
  side?: 'after' | 'before';
  label: string;
  head?: ReactNode;
  tail?: ReactNode;
  style?: CSSProperties;
  flyout?: ReturnType<typeof useFlyout>;
}) {
  const own = useFlyout();
  const f = flyout ?? own;
  const vertical = orient === 'vertical';
  const active = groups.find((g) => g.id === f.open && g.content);
  const btnRefs = useRef(new Map<string, HTMLButtonElement>());
  const anchor = active ? btnRefs.current.get(active.id) : null;
  // Second line: absolutely placed next to the bar, lined up with its group button.
  const flyStyle: CSSProperties = {
    position: 'absolute',
    zIndex: 5,
    display: 'flex',
    flexDirection: vertical ? 'column' : 'row',
    flexWrap: 'wrap',
    gap: 6,
    padding: 8,
    background: BAR_BG,
    border: '1px solid rgba(255,255,255,0.14)',
    borderRadius: 12,
    boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
    maxHeight: vertical ? 'calc(100% - 8px)' : undefined,
    maxWidth: vertical ? undefined : 'calc(100vw - 16px)',
    overflow: 'auto',
    ...(vertical
      ? { top: Math.max(4, (anchor?.offsetTop ?? 0) - 8), [side === 'after' ? 'left' : 'right']: '100%', [side === 'after' ? 'marginLeft' : 'marginRight']: 6 }
      : { left: Math.max(4, (anchor?.offsetLeft ?? 0) - 8), [side === 'after' ? 'top' : 'bottom']: '100%', [side === 'after' ? 'marginTop' : 'marginBottom']: 6 }),
  };
  return (
    <div
      {...f.rootProps}
      role="toolbar"
      aria-label={label}
      aria-orientation={orient}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: vertical ? 'column' : 'row',
        alignItems: 'center',
        gap: 6,
        padding: 6,
        background: BAR_BG,
        ...style,
      }}
    >
      {head}
      {groups.map((g) => (
        <button
          key={g.id}
          ref={(el) => {
            if (el) btnRefs.current.set(g.id, el);
            else btnRefs.current.delete(g.id);
          }}
          type="button"
          title={g.label}
          aria-label={g.label}
          data-testid={g.testId}
          disabled={g.disabled}
          style={barBtn(
            !!g.active || f.open === g.id,
            g.danger
              ? { background: '#b91c1c' }
              : g.warn
                ? { borderColor: '#f59e0b', color: '#fcd34d', background: 'transparent' }
                : g.disabled
                  ? { opacity: 0.45, cursor: 'default' }
                  : undefined
          )}
          {...(g.content ? f.groupProps(g.id) : { onClick: g.onClick })}
        >
          {g.icon}
          <Badge n={g.badge} />
        </button>
      ))}
      {tail}
      {active && (
        <div role="group" aria-label={active.label} data-flyout-open={active.id} style={flyStyle} {...f.optionProps} onClick={() => f.pick()}>
          {active.content}
        </div>
      )}
    </div>
  );
}

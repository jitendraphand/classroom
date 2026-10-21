'use client';

/**
 * Floating annotate tools. Same groups as the Windows tools window
 * (Draw, Erase & undo, Colour & size, student drawing, orientation, stop),
 * drawn with the web FlyoutBar. Marks land on the shared picture, not on
 * other applications.
 */
import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  IconArrow,
  IconClose,
  IconEllipse,
  IconEraser,
  IconHighlighter,
  IconLine,
  IconPen,
  IconRect,
  IconRedo,
  IconUndo,
} from '@/components/ui/Icons';
import { FlyoutBar, barBtn, type FlyoutGroup } from '@/lib/whiteboard/FlyoutBar';
import {
  ALLOW_GREEN,
  ANNOTATE_COLORS,
  ANNOTATE_DRAW_TOOLS,
  ANNOTATE_TOOLS_POS_KEY,
  THICKNESS_MAX,
  THICKNESS_MIN,
  clampPanel,
  flipOrient,
  parseAnnotateToolsPos,
  placeAnnotateTools,
  type AnnotateDrawTool,
} from '@/lib/shareChrome';
import { useTeacherInk } from './TeacherInk';

const DRAW_ICON: Record<AnnotateDrawTool, ReactNode> = {
  pen: <IconPen size={18} />,
  hl: <IconHighlighter size={18} />,
  line: <IconLine size={18} />,
  arrow: <IconArrow size={18} />,
  rect: <IconRect size={18} />,
  ellipse: <IconEllipse size={18} />,
};

const DRAW_LABEL: Record<AnnotateDrawTool, string> = {
  pen: 'Pen',
  hl: 'Highlighter',
  line: 'Line',
  arrow: 'Arrow',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
};

export type DrawPerson = { id: string; displayName: string };

/** Share pill rectangle in the same window as the tools panel. */
function shareBarBox(anchor: HTMLElement | null): { x: number; y: number; w: number; h: number } | null {
  const root = anchor?.closest('.tsh');
  const bar = root?.querySelector('[data-testid="share-toolbar"]');
  if (!(bar instanceof HTMLElement)) return null;
  const r = bar.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** Class title row (`data-float-bound="top"`). Zero when this window has no header. */
function headerBottomOf(doc: Document): number {
  let bottom = 0;
  doc.querySelectorAll<HTMLElement>('[data-float-bound="top"]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) bottom = Math.max(bottom, r.bottom);
  });
  return bottom;
}

export function AnnotateTools({
  requests,
  drawers,
  onAllow,
  onDeny,
  onClearStudents,
}: {
  requests: DrawPerson[];
  drawers: DrawPerson[];
  onAllow?: (id: string) => void;
  onDeny?: (id?: string) => void;
  onClearStudents?: () => void;
}) {
  const ink = useTeacherInk();
  const paneRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [mount, setMount] = useState<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{
    id: number;
    px: number;
    py: number;
    x: number;
    y: number;
    moved: boolean;
    latest: { x: number; y: number } | null;
  } | null>(null);

  useLayoutEffect(() => {
    setMount(anchorRef.current?.ownerDocument.body ?? null);
  }, [ink?.annotating]);

  useLayoutEffect(() => {
    if (!ink?.annotating) return;
    const el = paneRef.current;
    if (!el) return;
    const win = el.ownerDocument.defaultView;
    if (!win) return;
    const place = () => {
      if (drag.current) return;
      const node = paneRef.current;
      if (!node) return;
      const r = node.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return;
      const bar = shareBarBox(anchorRef.current);
      let saved: { x: number; y: number } | null = null;
      try {
        saved = parseAnnotateToolsPos(win.localStorage.getItem(ANNOTATE_TOOLS_POS_KEY));
      } catch {
        saved = null;
      }
      const next = placeAnnotateTools({
        panel: { w: r.width, h: r.height },
        viewport: { w: win.innerWidth, h: win.innerHeight },
        bar,
        saved,
        headerBottom: headerBottomOf(node.ownerDocument),
      });
      setPos((prev) => (prev && prev.x === next.x && prev.y === next.y ? prev : next));
    };
    place();
    const ro = new ResizeObserver(() => place());
    ro.observe(el);
    const barEl = anchorRef.current?.closest('.tsh')?.querySelector('[data-testid="share-toolbar"]');
    if (barEl) ro.observe(barEl);
    win.addEventListener('resize', place);
    return () => {
      ro.disconnect();
      win.removeEventListener('resize', place);
    };
  }, [ink?.annotating, ink?.orient, mount]);

  if (!ink?.annotating) return <span ref={anchorRef} hidden />;

  const tool = ink.tool;
  const drawingTool = tool === 'eraser' ? 'pen' : tool;
  const ic = (node: ReactNode) => node;

  const onGripDown = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (e.button !== undefined && e.button > 0) return;
    const el = paneRef.current;
    const win = el?.ownerDocument.defaultView;
    if (!el || !win) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = { id: e.pointerId, px: e.clientX, py: e.clientY, x: pos?.x ?? 0, y: pos?.y ?? 0, moved: false, latest: pos };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onGripMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    const el = paneRef.current;
    const win = el?.ownerDocument.defaultView;
    if (!d || d.id !== e.pointerId || !el || !win) return;
    const r = el.getBoundingClientRect();
    const next = clampPanel(
      { x: d.x + (e.clientX - d.px), y: d.y + (e.clientY - d.py) },
      { w: r.width, h: r.height },
      { w: win.innerWidth, h: win.innerHeight }
    );
    d.moved = true;
    d.latest = next;
    setPos(next);
  };
  const onGripUp = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const d = drag.current;
    if (d?.id !== e.pointerId) return;
    if (d.moved && d.latest) {
      try {
        e.currentTarget.ownerDocument.defaultView?.localStorage.setItem(ANNOTATE_TOOLS_POS_KEY, JSON.stringify(d.latest));
      } catch {
        /* private mode */
      }
    }
    drag.current = null;
  };

  const choose = (id: AnnotateDrawTool) => {
    ink.setTool(id);
  };

  const groups: FlyoutGroup[] = [
    {
      id: 'draw',
      label: 'Draw',
      icon: DRAW_ICON[drawingTool],
      active: tool !== 'eraser',
      testId: 'atb-g-draw',
      content: (
        <>
          {ANNOTATE_DRAW_TOOLS.map((id) => (
            <button
              key={id}
              type="button"
              title={DRAW_LABEL[id]}
              aria-label={DRAW_LABEL[id]}
              aria-pressed={tool === id}
              onClick={() => choose(id)}
              style={barBtn(tool === id)}
            >
              {DRAW_ICON[id]}
            </button>
          ))}
        </>
      ),
    },
    {
      id: 'erase',
      label: 'Erase and undo',
      icon: ic(<IconEraser size={18} />),
      active: tool === 'eraser',
      testId: 'atb-g-erase',
      content: (
        <>
          <button type="button" title="Eraser" aria-label="Eraser" aria-pressed={tool === 'eraser'} onClick={() => ink.setTool('eraser')} style={barBtn(tool === 'eraser')}>
            <IconEraser size={18} />
          </button>
          <button type="button" title="Undo" aria-label="Undo" disabled={!ink.canUndo} onClick={() => ink.undo()} style={barBtn(false, ink.canUndo ? undefined : { opacity: 0.45 })}>
            <IconUndo size={18} />
          </button>
          <button type="button" title="Redo" aria-label="Redo" disabled={!ink.canRedo} onClick={() => ink.redo()} style={barBtn(false, ink.canRedo ? undefined : { opacity: 0.45 })}>
            <IconRedo size={18} />
          </button>
          <button
            type="button"
            title="Clear student drawings"
            aria-label="Clear student drawings"
            onClick={() => onClearStudents?.()}
            style={barBtn()}
          >
            Clear
          </button>
          <button
            type="button"
            title="Clear all marks"
            aria-label="Clear all marks"
            onClick={() => {
              onClearStudents?.();
              ink.clear();
            }}
            style={barBtn(false, { background: '#b91c1c' })}
          >
            Clear all
          </button>
        </>
      ),
    },
    {
      id: 'color',
      label: 'Colour and size',
      icon: (
        <span
          aria-hidden
          style={{
            width: 8 + Math.min(14, ink.thickness),
            height: 8 + Math.min(14, ink.thickness),
            borderRadius: '50%',
            background: ink.color,
            border: '1px solid #fff8',
            display: 'block',
          }}
        />
      ),
      testId: 'atb-g-color',
      content: (
        <>
          {ANNOTATE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Colour ${c}`}
              aria-pressed={ink.color.toLowerCase() === c}
              title={`Colour ${c}`}
              onClick={() => ink.setColor(c)}
              style={{
                width: 28,
                height: 28,
                borderRadius: '50%',
                background: c,
                border: ink.color.toLowerCase() === c ? '3px solid #fff' : '1px solid #fff6',
                cursor: 'pointer',
                flex: 'none',
                padding: 0,
              }}
            />
          ))}
          <input
            type="range"
            min={THICKNESS_MIN}
            max={THICKNESS_MAX}
            step={1}
            value={ink.thickness}
            aria-label="Thickness"
            title={`Thickness ${ink.thickness}`}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => ink.setThickness(Number(e.target.value))}
            style={ink.orient === 'vertical' ? { writingMode: 'vertical-lr', height: 110 } : { width: 110 }}
          />
        </>
      ),
    },
    {
      id: 'perm',
      label: requests.length ? `${requests.length} asking to draw` : 'Student drawing',
      icon: ic(<IconPen size={18} />),
      badge: requests.length,
      active: drawers.length > 0,
      testId: 'atb-g-perm',
      content: (
        <>
          {!requests.length && !drawers.length ? (
            <span style={{ color: '#94a3b8', fontSize: 12, padding: 6 }}>No requests. Students ask with their pen button.</span>
          ) : null}
          {requests.map((p) => (
            <span key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#e2e8f0', fontSize: 12 }}>
              <span style={{ minWidth: 72 }}>{p.displayName}</span>
              <button
                type="button"
                data-testid="atb-draw-allow"
                title={`Let ${p.displayName} draw`}
                aria-label={`Allow ${p.displayName}`}
                onClick={() => onAllow?.(p.id)}
                style={barBtn(false, { background: ALLOW_GREEN })}
              >
                Allow
              </button>
              <button
                type="button"
                data-testid="atb-draw-deny"
                title={`Decline ${p.displayName}`}
                aria-label={`Deny ${p.displayName}`}
                onClick={() => onDeny?.(p.id)}
                style={barBtn()}
              >
                Deny
              </button>
            </span>
          ))}
          {drawers.map((p) => (
            <span key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#e2e8f0', fontSize: 12 }}>
              <span style={{ minWidth: 72 }}>✎ {p.displayName}</span>
              <button
                type="button"
                title={`Stop ${p.displayName}`}
                aria-label={`Stop ${p.displayName} drawing`}
                onClick={() => onDeny?.(p.id)}
                style={barBtn(false, { background: '#b91c1c' })}
              >
                Stop
              </button>
            </span>
          ))}
          {drawers.length > 1 ? (
            <button type="button" aria-label="Stop all student drawing" title="Stop all student drawing" onClick={() => onDeny?.()} style={barBtn(false, { background: '#b91c1c' })}>
              Stop all
            </button>
          ) : null}
        </>
      ),
    },
  ];

  const panel = (
    <div
      ref={paneRef}
      data-testid="annotate-tools"
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: pos?.x ?? 0,
        top: pos?.y ?? 0,
        visibility: pos ? 'visible' : 'hidden',
        zIndex: 120,
        width: 'max-content',
        maxWidth: 'calc(100vw - 12px)',
      }}
    >
      <FlyoutBar
        groups={groups}
        orient={ink.orient}
        side="after"
        label="Share tools"
        head={
          <span
            title="Drag to move"
            aria-hidden
            onPointerDown={onGripDown}
            onPointerMove={onGripMove}
            onPointerUp={onGripUp}
            onPointerCancel={onGripUp}
            style={{ cursor: 'grab', color: '#94a3b8', fontSize: 12, userSelect: 'none', touchAction: 'none', padding: '0 2px' }}
          >
            ⋮⋮
          </span>
        }
        tail={
          <>
            <button
              type="button"
              style={barBtn()}
              title={ink.orient === 'horizontal' ? 'Dock vertically' : 'Dock horizontally'}
              aria-label={ink.orient === 'horizontal' ? 'Dock vertically' : 'Dock horizontally'}
              onClick={() => ink.setOrient(flipOrient(ink.orient))}
            >
              {ink.orient === 'horizontal' ? '⇅' : '⇄'}
            </button>
            <button
              type="button"
              style={barBtn()}
              title="Stop annotating (removes your marks)"
              aria-label="Stop annotating"
              onClick={() => ink.setAnnotating(false)}
            >
              <IconClose size={18} />
            </button>
          </>
        }
        style={{ borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.45)' }}
      />
    </div>
  );
  return (
    <>
      <span ref={anchorRef} hidden />
      {mount ? createPortal(panel, mount) : panel}
    </>
  );
}

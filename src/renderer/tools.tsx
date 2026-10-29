import { installErrorReporter } from './errorReporter';
installErrorReporter('tools');
/**
 * Teacher share toolbar ("Annotate tools"): one compact grouped bar in its own
 * small, opaque, capture-EXCLUDED window (see WINDOW_CAPTURE_DECISIONS in
 * shared/capture.ts). Students see the marks on the captured overlay, never
 * this bar.
 *
 * Groups (one button each; hover or tap opens the group's second row/column
 * next to the bar, leaving closes it after a short grace period):
 *   Draw (pen, highlighter, shapes, text, laser) | Erase / undo (eraser, undo,
 *   redo, clear, clear student marks) | Colour / size | Meeting (mic, camera,
 *   chat, people, hands, admit) | Share (stop, video ↔ slides, computer
 *   sound) | Student drawing (requests allow / deny, stop all).
 * The window grows by the flyout's size on the side that has room, so the
 * compact bar itself never moves (main.ts `annotate-tools-flyout`).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { PanelSnapshot, TeacherAction } from '../shared/actions';
import { ANNOTATE_COLORS } from '../shared/annotate';
import { THICKNESS_MAX, THICKNESS_MIN, toolWidth, type AnnotateStatus, type OverlayTool } from '../shared/annotateOverlay';
import { ALL_TOOLS, parseOrient, tip, toolForKey, type ToolbarOrient } from '../shared/toolbarLayout';
import { FlyoutBar, barBtn, useFlyout, type FlyoutGroup } from '../shared/web/whiteboard/FlyoutBar';
import { desktop } from './bridge';
import type { IconName } from './icons';
import { Icon } from './teacherViews';

const HEX = /^#[0-9a-f]{6}$/i;
const ORIENT_KEY = 'classroom.annotateOrient';
/** Tools in the Draw group (eraser lives in Erase / undo). */
export const DRAW_TOOLS: OverlayTool[] = ['pen', 'highlight', 'line', 'arrow', 'rect', 'ellipse', 'text', 'laser'];

const send = (a: TeacherAction) => desktop().sendAction(a);
const ic = (name: IconName) => <Icon name={name} size={18} />;

function Opt({ on, label, onClick, children, disabled, danger, testId }: { on?: boolean; label: string; onClick: () => void; children: React.ReactNode; disabled?: boolean; danger?: boolean; testId?: string }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={on}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      style={barBtn(!!on, danger ? { background: '#b91c1c' } : disabled ? { opacity: 0.45, cursor: 'default' } : undefined)}
    >
      {children}
    </button>
  );
}

function Tools() {
  const [tool, setTool] = useState<OverlayTool>('pen');
  const [color, setColor] = useState<string>(ANNOTATE_COLORS[0] ?? '#ef4444');
  const [thickness, setThickness] = useState(3);
  const [drawing, setDrawing] = useState(true);
  const [snap, setSnap] = useState<PanelSnapshot | null>(null);
  const [orient, setOrient] = useState<ToolbarOrient>(() => {
    try {
      return parseOrient(localStorage.getItem(ORIENT_KEY));
    } catch {
      return 'horizontal';
    }
  });
  const [side, setSide] = useState<'after' | 'before'>('after');
  const [status, setStatus] = useState<AnnotateStatus>({ canUndo: false, canRedo: false, count: 0 });
  useEffect(() => desktop().onAnnotateStatus((next) => setStatus(next)), []);
  useEffect(() => desktop().onAnnotateMode((on) => setDrawing(on)), []);
  useEffect(() => desktop().onHud((s: PanelSnapshot) => s?.hud && setSnap(s)), []);
  useEffect(() => desktop().onToolsFlyoutSide?.((s) => setSide(s === 'before' ? 'before' : 'after')), []);
  useEffect(() => desktop().annotationCommand({ op: 'tool', tool }), [tool]);
  useEffect(() => desktop().annotationCommand({ op: 'color', color }), [color]);
  useEffect(() => desktop().annotationCommand({ op: 'width', width: toolWidth('pen', thickness) }), [thickness]);
  useEffect(() => {
    try {
      localStorage.setItem(ORIENT_KEY, orient);
    } catch {
      /* ignore */
    }
    desktop().annotateToolsOrient?.(orient);
  }, [orient]);
  const flyout = useFlyout();
  const barRef = useRef<HTMLDivElement>(null);
  // Report the compact bar's size once per orientation (main fits it to the work area).
  useEffect(() => {
    const el = barRef.current?.firstElementChild as HTMLElement | null;
    if (!el) return;
    const t = window.setTimeout(() => desktop().annotateToolsMeasure?.({ width: Math.ceil(el.offsetWidth) + 2, height: Math.ceil(el.offsetHeight) + 2, overflow: false }), 40);
    return () => window.clearTimeout(t);
  }, [orient]);
  // Flyout open: tell main how much room the second row/column needs; closed: 0.
  useLayoutEffect(() => {
    const fly = barRef.current?.querySelector('[data-flyout-open]') as HTMLElement | null;
    const size = fly ? (orient === 'horizontal' ? fly.offsetHeight + 8 : fly.offsetWidth + 8) : 0;
    const along = fly ? (orient === 'horizontal' ? fly.offsetLeft + fly.offsetWidth + 6 : fly.offsetTop + fly.offsetHeight + 6) : 0;
    desktop().annotateToolsFlyout?.({ size: Math.ceil(size), along: Math.ceil(along) });
  });
  const setMode = (on: boolean) => {
    setDrawing(on);
    desktop().annotationDrawMode(on);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        desktop().annotationCommand({ op: e.shiftKey ? 'redo' : 'undo' });
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        desktop().annotationCommand({ op: 'redo' });
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.toUpperCase() === 'M') {
        setDrawing((d) => {
          desktop().annotationDrawMode(!d);
          return !d;
        });
        return;
      }
      const hit = toolForKey(e.key);
      if (hit) setTool(hit.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const hud = snap?.hud;
  const choose = (t: OverlayTool) => {
    setTool(t);
    if (!drawing) setMode(true);
  };
  const toolIcon = (t: OverlayTool) => (ALL_TOOLS.find((d) => d.id === t)?.icon ?? 'pen') as IconName;
  const requests = (snap?.admitted ?? []).filter((p) => p.drawRequested && !p.drawing);
  const drawers = (snap?.admitted ?? []).filter((p) => p.drawing);
  const waiting = hud?.waitingCount ?? 0;
  const canStudentsDraw = !!hud && (hud.sharing || !!hud.whiteboardOn);

  const groups: FlyoutGroup[] = [
    {
      id: 'draw',
      label: 'Draw: pen, highlighter, shapes, text',
      icon: ic(DRAW_TOOLS.includes(tool) ? toolIcon(tool) : 'pen'),
      active: DRAW_TOOLS.includes(tool) && drawing,
      testId: 'atb-g-draw',
      content: DRAW_TOOLS.map((id) => {
        const d = ALL_TOOLS.find((t) => t.id === id)!;
        return (
          <Opt key={id} on={tool === id} label={tip(d.label, d.key)} onClick={() => choose(id)}>
            {ic(d.icon as IconName)}
          </Opt>
        );
      }),
    },
    {
      id: 'erase',
      label: 'Erase and undo',
      icon: ic('eraser'),
      active: tool === 'eraser' && drawing,
      testId: 'atb-g-erase',
      content: (
        <>
          <Opt on={tool === 'eraser'} label={tip('Eraser (also removes student strokes)', 'E')} onClick={() => choose('eraser')}>
            {ic('eraser')}
          </Opt>
          <Opt label={tip('Undo', 'Ctrl+Z')} disabled={!status.canUndo} onClick={() => desktop().annotationCommand({ op: 'undo' })}>
            {ic('undo')}
          </Opt>
          <Opt label={tip('Redo', 'Ctrl+Y')} disabled={!status.canRedo} onClick={() => desktop().annotationCommand({ op: 'redo' })}>
            {ic('redo')}
          </Opt>
          <Opt label="Clear student drawings (for everyone)" disabled={!status.students} onClick={() => desktop().clearStudentInk()}>
            {ic('people')}
          </Opt>
          <Opt
            label="Clear all marks: yours and the students'"
            danger
            disabled={!status.count && !status.students}
            onClick={() => {
              desktop().annotationCommand({ op: 'clear' });
              if (status.students) desktop().clearStudentInk();
            }}
          >
            {ic('trash')}
          </Opt>
        </>
      ),
    },
    {
      id: 'color',
      label: 'Colour and size',
      icon: <span aria-hidden="true" style={{ width: 8 + thickness, height: 8 + thickness, maxWidth: 22, maxHeight: 22, borderRadius: '50%', background: color, border: '1px solid #fff8' }} />,
      testId: 'atb-g-color',
      content: (
        <>
          {ANNOTATE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={color.toLowerCase() === c.toLowerCase()}
              title={`Colour ${c}`}
              aria-label={`Colour ${c}`}
              onClick={() => setColor(c)}
              style={{ width: 28, height: 28, borderRadius: '50%', background: c, border: color.toLowerCase() === c.toLowerCase() ? '3px solid #fff' : '1px solid #fff6', cursor: 'pointer', flex: 'none' }}
            />
          ))}
          <input type="color" value={color} title="Any colour" aria-label="Pick any colour" onChange={(e) => HEX.test(e.target.value) && setColor(e.target.value)} style={{ width: 32, height: 30, flex: 'none' }} />
          <input
            type="range"
            min={THICKNESS_MIN}
            max={THICKNESS_MAX}
            step={1}
            value={thickness}
            aria-label="Thickness"
            title={`Thickness ${thickness}`}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setThickness(Number(e.target.value))}
            style={orient === 'vertical' ? { writingMode: 'vertical-lr', height: 110 } : { width: 110 }}
          />
        </>
      ),
    },
    {
      id: 'meeting',
      icon: ic(hud && !hud.micOn ? 'micOff' : 'mic'),
      danger: !!hud && (!hud.micOn || hud.focusAlerts > 0),
      label: hud?.focusAlerts ? `Meeting: ${hud.focusAlerts} student(s) left fullscreen` : 'Meeting: mic, camera, chat, people, hands',
      badge: (hud?.unread ?? 0) + (hud?.hands ?? 0) + waiting + (hud?.focusAlerts ?? 0),
      testId: 'atb-g-meeting',
      content: hud && (
        <>
          <Opt on={!hud.micOn} danger={!hud.micOn} label={hud.micOn ? 'Mute mic' : 'Unmute mic'} onClick={() => send({ type: 'toggle-mic' })}>
            {ic(hud.micOn ? 'mic' : 'micOff')}
          </Opt>
          <Opt on={!hud.camOn} label={hud.camOn ? 'Turn camera off' : 'Turn camera on'} onClick={() => send({ type: 'toggle-cam' })}>
            {ic(hud.camOn ? 'cam' : 'camOff')}
          </Opt>
          <Opt label="Microphone, camera and noise removal" onClick={() => desktop().togglePanel('devices')} testId="atb-devices">
            {ic('mic')}
            {'⚙'}
          </Opt>
          <Opt label={hud.unread ? `Chat (${hud.unread} unread)` : 'Chat'} onClick={() => desktop().togglePanel('chat')}>
            {ic('chat')}
            {hud.unread ? hud.unread : null}
          </Opt>
          <Opt label={hud.hands ? `Raised hands (${hud.hands})` : 'Raised hands'} onClick={() => desktop().togglePanel('roster')}>
            {ic('hand')}
            {hud.hands ? hud.hands : null}
          </Opt>
          <Opt label={hud.focusAlerts ? `People: ${hud.focusAlerts} left fullscreen` : 'People'} danger={hud.focusAlerts > 0} onClick={() => desktop().togglePanel('roster')} testId="atb-focus-people">
            {ic('people')}
            {hud.focusAlerts ? `⛶${hud.focusAlerts}` : null}
          </Opt>
          <Opt
            label={waiting > 1 ? `Admit all ${waiting} waiting` : waiting === 1 && hud.oldestWaitingName ? `Admit ${hud.oldestWaitingName}` : 'Nobody waiting'}
            disabled={!waiting}
            onClick={() => (waiting > 1 ? send({ type: 'admit-all' }) : hud.oldestWaitingId && send({ type: 'admit', id: hud.oldestWaitingId }))}
          >
            {ic('userPlus')}
            {waiting ? waiting : null}
          </Opt>
          <Opt on={hud.videosOn} label={hud.videosOn ? 'Close student videos' : 'Student videos'} onClick={() => send({ type: 'toggle-videos' })}>
            {ic('video')}
          </Opt>
        </>
      ),
    },
    {
      id: 'share',
      label: 'Share: stop, video or slides mode, computer sound',
      icon: ic('share'),
      active: !!hud?.sharing,
      testId: 'atb-g-share',
      content: hud && (
        <>
          <Opt on={hud.videoMode} label={hud.videoMode ? 'Video mode on (click for sharp slides)' : 'Slides mode (click for smooth video)'} onClick={() => send({ type: 'toggle-video-mode' })}>
            {ic('film')}
            {hud.videoMode ? 'Video' : 'Slides'}
          </Opt>
          <Opt
            on={hud.shareAudio}
            label={hud.shareAudio ? "Students hear your computer's sound (the class's own voices are left out). Click to stop." : "Send your computer's sound (off by default)"}
            onClick={() => send({ type: 'toggle-share-audio' })}
          >
            {ic(hud.shareAudio ? 'speaker' : 'speakerOff')}
          </Opt>
          <Opt label="Stop sharing" danger onClick={() => send({ type: 'stop-share' })} testId="atb-stop-share">
            {ic('stop')}
            Stop
          </Opt>
        </>
      ),
    },
    {
      id: 'perm',
      label: requests.length ? `Student drawing (${requests.length} asking)` : 'Student drawing permissions',
      icon: ic('pen'),
      badge: requests.length,
      active: drawers.length > 0,
      testId: 'atb-g-perm',
      content: (
        <>
          {!requests.length && !drawers.length ? <span style={{ color: '#94a3b8', fontSize: 12, padding: 6 }}>No requests. Students ask with their pen button.</span> : null}
          {requests.map((p) => (
            <span key={p.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#e2e8f0', fontSize: 12 }}>
              {p.displayName}
              <Opt label={`Let ${p.displayName} draw`} disabled={!canStudentsDraw} onClick={() => send({ type: 'draw-allow', id: p.id })} testId="atb-draw-allow">
                {ic('check')}
              </Opt>
              <Opt label={`Decline ${p.displayName}`} onClick={() => send({ type: 'draw-revoke', id: p.id })} testId="atb-draw-deny">
                {ic('close')}
              </Opt>
            </span>
          ))}
          {drawers.length ? (
            <Opt label="Stop all student drawing" danger onClick={() => send({ type: 'draw-revoke' })}>
              Stop {drawers.length}
            </Opt>
          ) : null}
        </>
      ),
    },
  ];

  const head = (
    <>
      <span className="atb-grip" title="Drag to move" aria-hidden="true">
        ⋮⋮
      </span>
      <button
        type="button"
        style={barBtn(drawing)}
        aria-pressed={drawing}
        onClick={() => setMode(!drawing)}
        title={tip(drawing ? 'Drawing: the mouse draws. Click for click-through' : 'Click-through: use your apps. Click to draw', 'M')}
        aria-label={drawing ? 'Drawing (switch to click-through)' : 'Click-through (switch to drawing)'}
      >
        {ic(drawing ? 'pen' : 'pointer')}
      </button>
    </>
  );
  const tail = (
    <>
      <button
        type="button"
        style={barBtn()}
        onClick={() => setOrient(orient === 'horizontal' ? 'vertical' : 'horizontal')}
        title={orient === 'horizontal' ? 'Dock vertically' : 'Dock horizontally'}
        aria-label={orient === 'horizontal' ? 'Dock vertically' : 'Dock horizontally'}
      >
        {orient === 'horizontal' ? '⇅' : '⇄'}
      </button>
      <button type="button" style={barBtn()} title="Stop annotating (removes your marks)" aria-label="Stop annotating" onClick={() => send({ type: 'toggle-annotate' })}>
        {ic('close')}
      </button>
    </>
  );
  const vertical = orient === 'vertical';
  // The bar sits on the window edge away from the flyout, so opening it never moves the bar.
  return (
    <div
      ref={barRef}
      className={`atb2 atb2-${orient}`}
      style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: vertical ? 'row' : 'column', justifyContent: side === 'before' ? 'flex-end' : 'flex-start', alignItems: 'flex-start' }}
    >
      <FlyoutBar groups={groups} orient={orient} side={side} label="Share tools" head={head} tail={tail} flyout={flyout} style={{ borderRadius: 12, flexWrap: 'wrap', maxHeight: vertical ? '100vh' : undefined }} />
    </div>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Tools />);

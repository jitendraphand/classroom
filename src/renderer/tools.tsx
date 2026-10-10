/**
 * Teacher annotation toolbar ("Annotate tools"): a compact floating bar in its
 * own small, opaque, capture-EXCLUDED window (see WINDOW_CAPTURE_DECISIONS in
 * shared/capture.ts). Students see the marks on the captured overlay, never
 * this bar.
 *
 * Groups: draw tools | shapes | text / laser | colour swatches + thickness |
 * undo / redo / clear | draw ↔ click-through | dock | close. Horizontal by
 * default, optional vertical dock. Tooltips show the keyboard shortcuts.
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ANNOTATE_COLORS } from '../shared/annotate';
import { THICKNESS_MAX, THICKNESS_MIN, toolWidth, type AnnotateStatus, type OverlayTool } from '../shared/annotateOverlay';
import { TOOL_GROUPS, parseOrient, tip, toolForKey, type ToolbarOrient } from '../shared/toolbarLayout';
import { desktop } from './bridge';
import type { IconName } from './icons';
import { Icon } from './teacherViews';

const HEX = /^#[0-9a-f]{6}$/i;
const ORIENT_KEY = 'classroom.annotateOrient';

function Sep() {
  return <span className="atb-sep" aria-hidden="true" />;
}

function Tools() {
  const [tool, setTool] = useState<OverlayTool>('pen');
  const [color, setColor] = useState<string>(ANNOTATE_COLORS[0] ?? '#ef4444');
  const [thickness, setThickness] = useState(3);
  const [drawing, setDrawing] = useState(true);
  const [orient, setOrient] = useState<ToolbarOrient>(() => {
    try {
      return parseOrient(localStorage.getItem(ORIENT_KEY));
    } catch {
      return 'horizontal';
    }
  });
  const [status, setStatus] = useState<AnnotateStatus>({ canUndo: false, canRedo: false, count: 0 });
  useEffect(() => desktop().onAnnotateStatus((next) => setStatus(next)), []);
  useEffect(() => desktop().onAnnotateMode((on) => setDrawing(on)), []);
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

  return (
    <div className={`atb atb-${orient}`} role="toolbar" aria-label="Annotate tools" aria-orientation={orient}>
      <span className="atb-grip" title="Drag to move" aria-hidden="true">
        ⋮⋮
      </span>
      <button
        type="button"
        className={drawing ? 'atb-btn atb-mode on' : 'atb-btn atb-mode'}
        aria-pressed={drawing}
        onClick={() => setMode(!drawing)}
        title={tip(drawing ? 'Drawing: the mouse draws. Click for click-through' : 'Click-through: use your apps. Click to draw', 'M')}
        aria-label={drawing ? 'Drawing (switch to click-through)' : 'Click-through (switch to drawing)'}
      >
        <Icon name={drawing ? 'pen' : 'pointer'} size={18} />
      </button>
      {TOOL_GROUPS.map((g) => (
        <div key={g.id} className="atb-group" role="radiogroup" aria-label={g.label}>
          <Sep />
          {g.tools.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={tool === t.id}
              className={tool === t.id ? 'atb-btn on' : 'atb-btn'}
              title={tip(t.label, t.key)}
              aria-label={t.label}
              onClick={() => {
                setTool(t.id);
                if (!drawing) setMode(true);
              }}
            >
              <Icon name={t.icon as IconName} size={18} />
            </button>
          ))}
        </div>
      ))}
      <Sep />
      <div className="atb-group atb-colors" role="radiogroup" aria-label="Colour">
        {ANNOTATE_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={color.toLowerCase() === c.toLowerCase()}
            className={color.toLowerCase() === c.toLowerCase() ? 'atb-swatch on' : 'atb-swatch'}
            style={{ background: c }}
            title={`Colour ${c}`}
            aria-label={`Colour ${c}`}
            onClick={() => setColor(c)}
          />
        ))}
        <input
          type="color"
          className="atb-picker"
          value={color}
          title="Any colour"
          aria-label="Pick any colour"
          onChange={(e) => {
            if (HEX.test(e.target.value)) setColor(e.target.value);
          }}
        />
      </div>
      <label className="atb-thick" title={`Thickness ${thickness}`}>
        <span className="atb-dot" style={{ width: 4 + thickness, height: 4 + thickness, background: color }} aria-hidden="true" />
        <input
          type="range"
          min={THICKNESS_MIN}
          max={THICKNESS_MAX}
          step={1}
          value={thickness}
          aria-label="Thickness"
          onChange={(e) => setThickness(Number(e.target.value))}
        />
      </label>
      <Sep />
      <div className="atb-group" aria-label="History">
        <button type="button" className="atb-btn" disabled={!status.canUndo} onClick={() => desktop().annotationCommand({ op: 'undo' })} title={tip('Undo', 'Ctrl+Z')} aria-label="Undo">
          <Icon name="undo" size={18} />
        </button>
        <button type="button" className="atb-btn" disabled={!status.canRedo} onClick={() => desktop().annotationCommand({ op: 'redo' })} title={tip('Redo', 'Ctrl+Y')} aria-label="Redo">
          <Icon name="redo" size={18} />
        </button>
        <button
          type="button"
          className="atb-btn"
          disabled={!status.students}
          onClick={() => desktop().clearStudentInk()}
          title="Clear student drawings (for everyone)"
          aria-label="Clear student drawings"
        >
          <Icon name="people" size={18} />
        </button>
        <button
          type="button"
          className="atb-btn danger"
          disabled={!status.count && !status.students}
          onClick={() => {
            desktop().annotationCommand({ op: 'clear' });
            if (status.students) desktop().clearStudentInk();
          }}
          title="Clear all marks: yours and the students'"
          aria-label="Clear all marks"
        >
          <Icon name="trash" size={18} />
        </button>
      </div>
      <Sep />
      <button
        type="button"
        className="atb-btn"
        onClick={() => setOrient(orient === 'horizontal' ? 'vertical' : 'horizontal')}
        title={orient === 'horizontal' ? 'Dock vertically' : 'Dock horizontally'}
        aria-label={orient === 'horizontal' ? 'Dock vertically' : 'Dock horizontally'}
      >
        {orient === 'horizontal' ? '⇅' : '⇄'}
      </button>
      <button
        type="button"
        className="atb-btn atb-close"
        title="Stop annotating (removes your marks)"
        aria-label="Stop annotating"
        onClick={() => desktop().sendAction({ type: 'toggle-annotate' })}
      >
        <Icon name="close" size={18} />
      </button>
    </div>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Tools />);

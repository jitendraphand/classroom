/**
 * Teacher annotation panel ("Annotate tools"): its own small, opaque,
 * capture-EXCLUDED window (see WINDOW_CAPTURE_DECISIONS in shared/capture.ts).
 * Students see the marks on the captured overlay, never this panel.
 *
 * Tools: pen, highlighter, line, arrow, rectangle, ellipse, text, laser,
 * eraser · undo / redo / clear · colour (swatches + picker) · thickness ·
 * Draw / Click-through (the overlay takes the mouse, or lets clicks reach
 * the apps underneath while the marks stay on screen).
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ANNOTATE_COLORS } from '../shared/annotate';
import { THICKNESS_MAX, THICKNESS_MIN, toolWidth, type AnnotateStatus, type OverlayTool } from '../shared/annotateOverlay';
import { desktop } from './bridge';
import type { IconName } from './icons';
import { Icon } from './teacherViews';

const TOOLS: { id: OverlayTool; label: string; icon: IconName; key: string }[] = [
  { id: 'pen', label: 'Pen', icon: 'pen', key: 'P' },
  { id: 'highlight', label: 'Highlighter', icon: 'highlighter', key: 'H' },
  { id: 'line', label: 'Line', icon: 'line', key: 'L' },
  { id: 'arrow', label: 'Arrow', icon: 'arrow', key: 'A' },
  { id: 'rect', label: 'Rectangle', icon: 'rect', key: 'R' },
  { id: 'ellipse', label: 'Ellipse', icon: 'ellipse', key: 'O' },
  { id: 'text', label: 'Text', icon: 'text', key: 'T' },
  { id: 'laser', label: 'Laser pointer', icon: 'laser', key: 'K' },
  { id: 'eraser', label: 'Eraser', icon: 'eraser', key: 'E' },
];

const HEX = /^#[0-9a-f]{6}$/i;

function Tools() {
  const [tool, setTool] = useState<OverlayTool>('pen');
  const [color, setColor] = useState<string>(ANNOTATE_COLORS[0] ?? '#ef4444');
  const [thickness, setThickness] = useState(3);
  const [drawing, setDrawing] = useState(true);
  const [status, setStatus] = useState<AnnotateStatus>({ canUndo: false, canRedo: false, count: 0 });
  useEffect(() => desktop().onAnnotateStatus((next) => setStatus(next)), []);
  useEffect(() => desktop().onAnnotateMode((on) => setDrawing(on)), []);
  useEffect(() => desktop().annotationCommand({ op: 'tool', tool }), [tool]);
  useEffect(() => desktop().annotationCommand({ op: 'color', color }), [color]);
  useEffect(() => desktop().annotationCommand({ op: 'width', width: toolWidth('pen', thickness) }), [thickness]);
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
      const hit = TOOLS.find((t) => t.key === e.key.toUpperCase());
      if (hit) setTool(hit.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const setMode = (on: boolean) => {
    setDrawing(on);
    desktop().annotationDrawMode(on);
  };
  return (
    <div className="tools-panel">
      <header className="tools-head">
        <span className="tools-title">Annotate</span>
        <button
          type="button"
          className="tools-close"
          title="Stop annotating (removes your marks)"
          aria-label="Stop annotating"
          onClick={() => desktop().sendAction({ type: 'toggle-annotate' })}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="tools-mode" role="radiogroup" aria-label="Mouse">
        <button type="button" role="radio" aria-checked={drawing} className={drawing ? 'on' : ''} onClick={() => setMode(true)} title="Draw on the screen">
          <Icon name="pen" size={13} />
          Draw
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={!drawing}
          className={!drawing ? 'on' : ''}
          onClick={() => setMode(false)}
          title="Click-through: use your apps; the marks stay on screen"
        >
          <Icon name="pointer" size={13} />
          Click-through
        </button>
      </div>
      <div className="tools-grid" role="radiogroup" aria-label="Tool">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={tool === t.id}
            className={tool === t.id ? 'tool on' : 'tool'}
            title={`${t.label} (${t.key})`}
            aria-label={t.label}
            onClick={() => {
              setTool(t.id);
              if (!drawing) setMode(true);
            }}
          >
            <Icon name={t.icon} size={18} />
          </button>
        ))}
      </div>
      <div className="tools-section">
        <span className="tools-label">Colour</span>
        <div className="tools-swatches">
          {ANNOTATE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={color.toLowerCase() === c.toLowerCase() ? 'swatch on' : 'swatch'}
              style={{ background: c }}
              title={c}
              aria-label={`Colour ${c}`}
              onClick={() => setColor(c)}
            />
          ))}
          <input
            type="color"
            className="tools-picker"
            value={color}
            title="Any colour"
            aria-label="Pick any colour"
            onChange={(e) => {
              if (HEX.test(e.target.value)) setColor(e.target.value);
            }}
          />
        </div>
      </div>
      <div className="tools-section">
        <label className="tools-label" htmlFor="thickness">
          Thickness <span className="tools-value">{thickness}</span>
        </label>
        <input
          id="thickness"
          type="range"
          min={THICKNESS_MIN}
          max={THICKNESS_MAX}
          step={1}
          value={thickness}
          onChange={(e) => setThickness(Number(e.target.value))}
        />
      </div>
      <div className="tools-actions">
        <button type="button" disabled={!status.canUndo} onClick={() => desktop().annotationCommand({ op: 'undo' })} title="Undo (Ctrl+Z)" aria-label="Undo">
          <Icon name="undo" size={16} />
        </button>
        <button type="button" disabled={!status.canRedo} onClick={() => desktop().annotationCommand({ op: 'redo' })} title="Redo (Ctrl+Y)" aria-label="Redo">
          <Icon name="redo" size={16} />
        </button>
        <button
          type="button"
          className="danger"
          disabled={!status.count}
          onClick={() => desktop().annotationCommand({ op: 'clear' })}
          title="Clear all marks"
          aria-label="Clear all marks"
        >
          <Icon name="trash" size={16} />
          Clear
        </button>
      </div>
      <p className="tools-hint">Students see your marks. This panel stays out of the shared picture.</p>
    </div>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Tools />);

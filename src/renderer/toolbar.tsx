import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HudState, PanelSnapshot, TeacherAction } from '../shared/actions';
import { ANNOTATE_COLORS } from '../shared/annotate';
import type { AnnotateStatus, OverlayTool } from '../shared/annotateOverlay';
import { desktop } from './bridge';
import { ICONS as I } from './icons';

function send(action: TeacherAction): void {
  desktop().sendAction(action);
}

function Badge({ n }: { n: number }) {
  if (!n) return null;
  return <span className="count">{n > 9 ? '9+' : String(n)}</span>;
}

function Icon({ html }: { html: string }) {
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

const TOOLS: { id: OverlayTool; label: string }[] = [
  { id: 'pen', label: 'Pen' },
  { id: 'arrow', label: 'Arrow' },
  { id: 'line', label: 'Line' },
  { id: 'rect', label: 'Rectangle' },
  { id: 'ellipse', label: 'Ellipse' },
  { id: 'text', label: 'Text' },
  { id: 'highlight', label: 'Highlight' },
  { id: 'laser', label: 'Laser' },
  { id: 'eraser', label: 'Eraser' },
];

function InkTools() {
  const [tool, setTool] = useState<OverlayTool>('pen');
  const [color, setColor] = useState(ANNOTATE_COLORS[0]!);
  const [status, setStatus] = useState<AnnotateStatus>({ canUndo: false, canRedo: false, count: 0 });
  useEffect(() => desktop().onAnnotateStatus((next) => setStatus(next)), []);
  useEffect(() => {
    desktop().annotationCommand({ op: 'tool', tool });
    desktop().annotationCommand({ op: 'color', color });
  }, [tool, color]);
  return (
    <div className="ink-tools">
      {TOOLS.map((item) => (
        <button key={item.id} type="button" className={tool === item.id ? 'on texty' : 'texty'} title={item.label} onClick={() => setTool(item.id)}>
          {item.label}
        </button>
      ))}
      {ANNOTATE_COLORS.map((swatch) => (
        <button
          key={swatch}
          type="button"
          className={color === swatch ? 'on swatch' : 'swatch'}
          title={swatch}
          style={{ background: swatch }}
          onClick={() => setColor(swatch)}
        />
      ))}
      <button type="button" className="texty" title="Undo" disabled={!status.canUndo} onClick={() => desktop().annotationCommand({ op: 'undo' })}>
        Undo
      </button>
      <button type="button" className="texty" title="Redo" disabled={!status.canRedo} onClick={() => desktop().annotationCommand({ op: 'redo' })}>
        Redo
      </button>
      <button type="button" className="texty danger" title="Clear annotations" onClick={() => desktop().annotationCommand({ op: 'clear' })}>
        Clear
      </button>
    </div>
  );
}

function Toolbar({ hud }: { hud: HudState }) {
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const r = bar.current?.getBoundingClientRect();
    if (!r) return;
    desktop().resizeToolbar(Math.ceil(r.width), Math.ceil(r.height));
  });
  const rosterN = hud.hands + hud.waitingCount + hud.focusAlerts;
  return (
    <div id="bar" ref={bar}>
      <div className="bar-row">
      <div className="grip" title="Drag">⋮⋮</div>
      {hud.sharing ? <span className="sharing-pill">Sharing</span> : null}
      <button
        id="mic"
        type="button"
        title={hud.micOn ? 'Mute microphone' : 'Unmute microphone'}
        aria-label={hud.micOn ? 'Mute microphone' : 'Unmute microphone'}
        aria-pressed={hud.micOn}
        className={hud.micOn ? 'on' : 'danger'}
        onClick={() => send({ type: 'toggle-mic' })}
      >
        <Icon html={hud.micOn ? I.mic : I.micOff} />
      </button>
      <button
        id="cam"
        type="button"
        title={hud.camOn ? 'Turn camera off' : 'Turn camera on'}
        aria-label={hud.camOn ? 'Turn camera off' : 'Turn camera on'}
        aria-pressed={hud.camOn}
        className={hud.camOn ? 'on' : 'danger'}
        onClick={() => send({ type: 'toggle-cam' })}
      >
        <Icon html={hud.camOn ? I.cam : I.camOff} />
      </button>
      {hud.sharing ? (
        <button id="stop" type="button" className="danger" title="Stop sharing" aria-label="Stop sharing" onClick={() => send({ type: 'stop-share' })}>
          <Icon html={I.stop} />
        </button>
      ) : (
        <button id="share" type="button" title="Share the screen" aria-label="Share the screen" onClick={() => send({ type: 'open-share' })}>
          <Icon html={I.share} />
        </button>
      )}
      <button
        id="pen"
        type="button"
        title="Draw on the screen. Students see the marks. Classroom windows stay out of the picture."
        className={hud.annotateOn ? 'on' : ''}
        onClick={() => send({ type: 'toggle-annotate' })}
      >
        <Icon html={I.pen} />
      </button>
      <button id="chat" type="button" title="Messages" aria-label="Messages" onClick={() => desktop().togglePanel('chat')}>
        <Icon html={I.chat} />
        <Badge n={hud.unread} />
      </button>
      <button id="roster" type="button" title="People" aria-label="People" onClick={() => desktop().togglePanel('roster')}>
        <Icon html={I.people} />
        <Badge n={rosterN} />
      </button>
      <button
        id="videos"
        type="button"
        title={hud.videosOn ? 'Close student videos' : 'Open student videos'}
        aria-label={hud.videosOn ? 'Close student videos' : 'Open student videos'}
        aria-pressed={hud.videosOn}
        className={hud.videosOn ? 'on' : ''}
        onClick={() => send({ type: 'toggle-videos' })}
      >
        <Icon html={I.video} />
      </button>
      {hud.waitingCount > 0 && hud.oldestWaitingId ? (
        <button
          type="button"
          className="admit"
          title={hud.oldestWaitingName ? `Admit ${hud.oldestWaitingName}` : 'Admit'}
          onClick={() => send({ type: 'admit', id: hud.oldestWaitingId as string })}
        >
          Admit {hud.waitingCount}
        </button>
      ) : null}
      {hud.waitingCount > 1 ? (
        <button type="button" className="admit" title="Admit everyone in the lobby" aria-label="Admit all" onClick={() => send({ type: 'admit-all' })}>
          Admit all
        </button>
      ) : null}
      </div>
      {hud.sharing && hud.annotateOn ? <InkTools /> : null}
    </div>
  );
}

function Root() {
  const [hud, setHud] = useState<HudState | null>(null);
  useEffect(() => desktop().onHud((snap: PanelSnapshot) => {
    if (snap?.hud) setHud(snap.hud);
  }), []);
  if (!hud) return <div id="bar" />;
  return <Toolbar hud={hud} />;
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Root />);

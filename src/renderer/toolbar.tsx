import { installErrorReporter } from './errorReporter';
installErrorReporter('toolbar');
/**
 * Share controls: the same buttons, order, icons and labels as the website's
 * share HUD (TeacherShareHud): Live · mic · camera · videos · Video | chat ·
 * hands · roster · admit · annotate | Stop. Annotation tools live in their own
 * window (tools.tsx). This window is excluded from capture (see
 * WINDOW_CAPTURE_DECISIONS in shared/capture.ts).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HudState, PanelSnapshot, TeacherAction } from '../shared/actions';
import { desktop } from './bridge';
import { Icon } from './teacherViews';

function send(action: TeacherAction): void {
  desktop().sendAction(action);
}

function Count({ n, blue }: { n: number; blue?: boolean }) {
  if (!n) return null;
  return <span className={blue ? 'tsh-count tsh-count-blue' : 'tsh-count'}>{n > 9 ? '9+' : String(n)}</span>;
}

function Toolbar({ hud }: { hud: HudState }) {
  const bar = useRef<HTMLDivElement>(null);
  // Adaptive capture indicator: visible whenever a busy PC made the share smaller / slower.
  const [adaptive, setAdaptive] = useState<{ level: number; label: string; cpu: number }>({ level: 0, label: '', cpu: 0 });
  useEffect(() => desktop().onAdaptiveStatus?.((st) => st && typeof st === 'object' && setAdaptive(st as { level: number; label: string; cpu: number })), []);
  useLayoutEffect(() => {
    const r = bar.current?.getBoundingClientRect();
    if (!r) return;
    desktop().resizeToolbar(Math.ceil(r.width), Math.ceil(r.height));
  });
  const waiting = hud.waitingCount;
  const admitLabel = waiting > 1 ? `Admit all ${waiting} waiting` : waiting === 1 && hud.oldestWaitingName ? `Admit ${hud.oldestWaitingName}` : 'Nobody waiting';
  const videoTitle = hud.videoMode
    ? 'Video mode on: smooth 30 fps with sound for a playing video. Click for sharp slides/text.'
    : 'Playing a video? Video mode sends smooth 30 fps and your computer sound (slides and text get slightly softer).';
  return (
    <div id="bar" ref={bar} className="tsh">
      <div className="tsh-bar" role="toolbar" aria-label="Share tools">
        <span className="grip" title="Drag">⋮⋮</span>
        {hud.sharing ? <span className="tsh-live">Live</span> : null}
        {hud.sharing && adaptive.level > 0 ? (
          <span className="tsh-live" data-testid="tsh-adaptive" style={{ background: '#b45309' }} title={`${adaptive.label}: CPU ${adaptive.cpu}%. Students get a smaller, slower picture until the PC is less busy.`}>
            {adaptive.level === 2 ? 'Low' : 'Reduced'}
          </span>
        ) : null}
        <button
          type="button"
          className="tsh-btn"
          aria-pressed={!hud.micOn}
          onClick={() => send({ type: 'toggle-mic' })}
          aria-label={hud.micOn ? 'Mute mic' : 'Unmute mic'}
          title={hud.micOn ? 'Mute mic' : 'Unmute mic'}
        >
          <Icon name={hud.micOn ? 'mic' : 'micOff'} />
        </button>
        <button
          type="button"
          className="tsh-btn"
          aria-pressed={!hud.camOn}
          onClick={() => send({ type: 'toggle-cam' })}
          aria-label={hud.camOn ? 'Turn camera off' : 'Turn camera on'}
          title={hud.camOn ? 'Turn camera off' : 'Turn camera on'}
        >
          <Icon name={hud.camOn ? 'cam' : 'camOff'} />
        </button>
        <button
          type="button"
          className="tsh-btn"
          aria-pressed={hud.videosOn}
          onClick={() => send({ type: 'toggle-videos' })}
          aria-label={hud.videosOn ? 'Close student videos window' : 'Show student videos'}
          title={hud.videosOn ? 'Close student videos window' : 'Student videos (2/4/6, pins, rotation)'}
        >
          <Icon name="video" />
        </button>
        {hud.sharing ? (
          <button
            type="button"
            className="tsh-btn"
            aria-pressed={hud.videoMode}
            onClick={() => send({ type: 'toggle-video-mode' })}
            title={videoTitle}
            aria-label={hud.videoMode ? 'Video mode on (turn off for slides)' : 'Video mode (smooth playback)'}
          >
            <Icon name="film" />
            Video
          </button>
        ) : null}
        <button
          type="button"
          className="tsh-btn"
          aria-pressed={!!hud.lowPower}
          onClick={() => send({ type: 'toggle-low-power' })}
          title={hud.lowPower ? 'Low power on: slides 5 fps, video 15 fps, smaller student tiles. Click for normal.' : 'Low power: fewer frames (slides 5 fps, video 15 fps, smaller student tiles)'}
          aria-label={hud.lowPower ? 'Low power on (click for normal)' : 'Low power mode'}
        >
          Eco
        </button>
        {hud.sharing ? (
          <button
            type="button"
            className="tsh-btn"
            aria-pressed={hud.shareAudio}
            onClick={() => send({ type: 'toggle-share-audio' })}
            title={
              hud.shareAudio
                ? `Students hear your computer's sound${hud.shareAudioAuto ? ' (on with Video mode)' : ''}. Click to stop.`
                : `Send your computer's sound (video audio) to students.${hud.shareAudioAuto ? ' Turns on with Video mode.' : ''}`
            }
            aria-label={hud.shareAudio ? 'Computer sound on (click to stop)' : 'Send computer sound'}
          >
            <Icon name={hud.shareAudio ? 'speaker' : 'speakerOff'} />
          </button>
        ) : null}
        <span className="tsh-sep" aria-hidden="true" />
        <button type="button" className="tsh-btn" onClick={() => desktop().togglePanel('chat')} aria-label="Chat" title="Chat">
          <Icon name="chat" />
          <Count n={hud.unread} />
        </button>
        <button
          type="button"
          className="tsh-btn"
          onClick={() => desktop().togglePanel('roster')}
          aria-label="Raised hands"
          title="Raised hands (listed first in the roster)"
        >
          <Icon name="hand" />
          <Count n={hud.hands} />
        </button>
        <button
          type="button"
          className="tsh-btn"
          onClick={() => desktop().togglePanel('roster')}
          aria-label={[hud.drawRequests ? `${hud.drawRequests} asking to draw` : '', hud.focusAlerts ? `${hud.focusAlerts} left fullscreen` : ''].filter(Boolean).join(', ') ? `Roster (${[hud.drawRequests ? `${hud.drawRequests} asking to draw` : '', hud.focusAlerts ? `${hud.focusAlerts} left fullscreen` : ''].filter(Boolean).join(', ')})` : 'Roster'}
          title={hud.drawRequests ? `Roster: ${hud.drawRequests} asking to draw` : 'Roster'}
        >
          <Icon name="people" />
          <Count n={waiting} />
          {hud.focusAlerts > 0 ? (
            <span className="tsh-count tsh-focus" data-testid="tsh-focus-alert" title={`${hud.focusAlerts} left fullscreen`} style={{ background: '#dc2626', color: '#fff', left: -4, right: 'auto' }}>
              ⛶{hud.focusAlerts}
            </span>
          ) : null}
          {hud.drawRequests > 0 ? <span className="tsh-pen-dot" aria-hidden="true" /> : null}
        </button>
        {/* Always present (fixed width), like the website: nothing appears or disappears on its own. */}
        <button
          type="button"
          className={waiting > 0 ? 'tsh-btn tsh-icon is-warn' : 'tsh-btn tsh-icon'}
          disabled={waiting === 0}
          onClick={() => (waiting > 1 ? send({ type: 'admit-all' }) : hud.oldestWaitingId && send({ type: 'admit', id: hud.oldestWaitingId }))}
          aria-label={admitLabel}
          title={admitLabel}
        >
          <Icon name="userPlus" />
        </button>
        {hud.sharing ? (
          <button
            type="button"
            className="tsh-btn"
            aria-pressed={hud.annotateOn}
            onClick={() => send({ type: 'toggle-annotate' })}
            aria-label={hud.annotateOn ? 'Stop annotating' : 'Annotate'}
            title={hud.annotateOn ? 'Stop annotating (removes your marks)' : 'Annotate: draw on your screen. Students see the marks; Classroom windows stay out of the picture.'}
          >
            <Icon name="pen" />
          </button>
        ) : null}
        <span className="tsh-sep" aria-hidden="true" />
        {hud.sharing ? (
          <button type="button" className="tsh-btn tsh-btn-danger" onClick={() => send({ type: 'stop-share' })} title="Stop sharing">
            <Icon name="share" />
            Stop
          </button>
        ) : (
          <button type="button" className="tsh-btn" onClick={() => send({ type: 'open-share' })} title="Share screen" aria-label="Share screen">
            <Icon name="share" />
            Share
          </button>
        )}
      </div>
      {hud.notice ? <div className="tsh-tip">{hud.notice}</div> : null}
    </div>
  );
}

function Root() {
  const [hud, setHud] = useState<HudState | null>(null);
  useEffect(
    () =>
      desktop().onHud((snap: PanelSnapshot) => {
        if (snap?.hud) setHud(snap.hud);
      }),
    []
  );
  if (!hud) return <div id="bar" />;
  return <Toolbar hud={hud} />;
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Root />);

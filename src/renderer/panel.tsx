import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { PanelSnapshot, TeacherAction } from '../shared/actions';
import { desktop } from './bridge';
import { ChatView, RosterView } from './teacherViews';

const kind = new URLSearchParams(location.search).get('kind') || 'chat';

function send(action: TeacherAction): void {
  desktop().sendAction(action);
}

function Devices({ snap }: { snap: PanelSnapshot }) {
  const mics = snap.devices.filter((d) => d.kind === 'audioinput');
  const cams = snap.devices.filter((d) => d.kind === 'videoinput');
  return (
    <>
      <div className="pane-head">
        <div>
          <h2>This class</h2>
          <p className="hint">Pick the microphone and camera Classroom should use.</p>
        </div>
      </div>
      <label htmlFor="mic-dev">Microphone</label>
      <select id="mic-dev" value={mics.some((d) => d.id === snap.micId) ? snap.micId : ''} onChange={(e) => send({ type: 'set-mic', deviceId: e.target.value })}>
        <option value="">System default</option>
        {mics.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
      </select>
      <label htmlFor="cam-dev">Camera</label>
      <select id="cam-dev" value={cams.some((d) => d.id === snap.camId) ? snap.camId : ''} onChange={(e) => send({ type: 'set-cam', deviceId: e.target.value })}>
        <option value="">System default</option>
        {cams.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
      </select>
      <p className="hint">Shortcuts use Electron accelerators, for example CommandOrControl+Shift+M.</p>
    </>
  );
}

function Panel() {
  const [snap, setSnap] = useState<PanelSnapshot | null>(null);
  useEffect(() => desktop().onHud((next) => {
    if (next?.hud) setSnap(next);
  }), []);
  if (!snap) return <p className="hint">Waiting for the class…</p>;
  if (kind === 'roster') return <RosterView snap={snap} send={send} showLayout />;
  if (kind === 'devices') return <Devices snap={snap} />;
  return <ChatView snap={snap} send={send} />;
}

const title = document.getElementById('title');
if (title) title.textContent = kind === 'roster' ? 'Roster' : kind === 'devices' ? 'Devices' : 'Chat';
document.getElementById('close')?.addEventListener('click', () => desktop().togglePanel(kind as 'chat' | 'roster' | 'devices'));

const body = document.getElementById('body');
if (body) createRoot(body).render(<Panel />);

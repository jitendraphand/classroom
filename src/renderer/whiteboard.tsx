import { useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import type { PanelSnapshot } from '../shared/actions';
import { WhiteboardBoard } from '../shared/web/whiteboard/WhiteboardBoard';
import { FlyoutBar, barBtn, type FlyoutGroup } from '../shared/web/whiteboard/FlyoutBar';
import type { WhiteboardSession } from '../shared/web/whiteboard/session';
import type { Op } from '../shared/web/whiteboard/model';
import type { IconName } from './icons';
import { Icon } from './teacherViews';
import type { WbMeeting } from './whiteboardHost';

/**
 * Whiteboard window: the class window hands over its session (same renderer
 * process). Board tools dock LEFT (grouped flyout bar from the web board), the
 * meeting bar docks RIGHT (mic, camera, chat with reply, people / hands, admit,
 * student drawing allow / deny, mute all, student videos, stop, end). Student
 * videos float in their own draggable, minimisable window.
 */
const ic = (n: IconName) => <Icon name={n} size={18} />;

export function MeetingBar({ meeting, onStop }: { meeting: WbMeeting; onStop: () => void }) {
  const snap: PanelSnapshot = useSyncExternalStore(meeting.subscribe, meeting.snapshot);
  const hud = snap.hud;
  const send = meeting.send;
  const requests = snap.admitted.filter((p) => p.drawRequested && !p.drawing);
  const drawers = snap.admitted.filter((p) => p.drawing);
  const waiting = hud.waitingCount;
  const [allMuted, setAllMuted] = useState(false);
  const groups: FlyoutGroup[] = [
    { id: 'mic', label: hud.micOn ? 'Mute mic' : 'Unmute mic', icon: ic(hud.micOn ? 'mic' : 'micOff'), danger: !hud.micOn, onClick: () => send({ type: 'toggle-mic' }), testId: 'wbm-mic' },
    { id: 'cam', label: hud.camOn ? 'Turn camera off' : 'Turn camera on', icon: ic(hud.camOn ? 'cam' : 'camOff'), onClick: () => send({ type: 'toggle-cam' }), testId: 'wbm-cam' },
    { id: 'chat', label: 'Chat (reply to students)', icon: ic('chat'), badge: hud.unread, onClick: () => meeting.togglePanel('chat'), testId: 'wbm-chat' },
    { id: 'people', label: hud.hands ? `People (${hud.hands} raised hands)` : 'People and raised hands', icon: ic(hud.hands ? 'hand' : 'people'), badge: hud.hands, onClick: () => meeting.togglePanel('roster'), testId: 'wbm-people' },
    {
      id: 'admit',
      label: waiting > 1 ? `Admit all ${waiting} waiting` : waiting === 1 && hud.oldestWaitingName ? `Admit ${hud.oldestWaitingName}` : 'Nobody waiting',
      icon: ic('userPlus'),
      badge: waiting,
      disabled: waiting === 0,
      onClick: () => (waiting > 1 ? send({ type: 'admit-all' }) : hud.oldestWaitingId && send({ type: 'admit', id: hud.oldestWaitingId })),
      testId: 'wbm-admit',
    },
    {
      id: 'perm',
      label: requests.length ? `${requests.length} asking to draw` : 'Student drawing',
      icon: ic('pen'),
      badge: requests.length,
      active: drawers.length > 0,
      testId: 'wbm-perm',
      content: (
        <>
          {!requests.length && !drawers.length ? <span style={{ color: '#94a3b8', fontSize: 12, padding: 6, width: 160 }}>No requests. Students ask with their pen button.</span> : null}
          {requests.map((p) => (
            <span key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#e2e8f0', fontSize: 12 }}>
              <span style={{ flex: 1, minWidth: 80 }}>{p.displayName}</span>
              <button type="button" style={barBtn(false, { background: '#15803d' })} data-testid="wbm-draw-allow" title={`Let ${p.displayName} draw on the board`} onClick={() => send({ type: 'draw-allow', id: p.id })}>
                Allow
              </button>
              <button type="button" style={barBtn()} data-testid="wbm-draw-deny" title={`Decline ${p.displayName}`} onClick={() => send({ type: 'draw-revoke', id: p.id })}>
                Deny
              </button>
            </span>
          ))}
          {drawers.map((p) => (
            <span key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#e2e8f0', fontSize: 12 }}>
              <span style={{ flex: 1, minWidth: 80 }}>✎ {p.displayName}</span>
              <button type="button" style={barBtn(false, { background: '#b91c1c' })} onClick={() => send({ type: 'draw-revoke', id: p.id })}>
                Stop
              </button>
            </span>
          ))}
        </>
      ),
    },
    {
      id: 'muteall',
      label: allMuted ? 'Let students unmute' : 'Mute all students',
      icon: ic(allMuted ? 'speakerOff' : 'speaker'),
      active: allMuted,
      onClick: () => {
        send({ type: 'mute-all', muted: !allMuted });
        setAllMuted(!allMuted);
      },
      testId: 'wbm-mute-all',
    },
    { id: 'videos', label: hud.videosOn ? 'Close student videos' : 'Show student videos', icon: ic('video'), active: hud.videosOn, onClick: () => send({ type: 'toggle-videos' }), testId: 'wbm-videos' },
  ];
  const tail = (
    <>
      <span style={{ flex: 1 }} />
      <button type="button" style={barBtn(false, { background: '#b91c1c', width: 40 })} title="Stop whiteboard sharing" aria-label="Stop whiteboard sharing" data-testid="wbm-stop" onClick={onStop}>
        {ic('stop')}
      </button>
      <button type="button" style={barBtn(false, { width: 40, fontSize: 11 })} title="End the class for everyone" aria-label="End class" data-testid="wbm-end" onClick={() => send({ type: 'end' })}>
        End
      </button>
    </>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <FlyoutBar groups={groups} orient="vertical" side="before" label="Meeting" tail={tail} style={{ height: '100%', width: 54, boxSizing: 'border-box', borderLeft: '1px solid #ffffff1f' }} />
    </div>
  );
}

function App({ session, identity, onSend, onClose, meeting }: { session: WhiteboardSession; identity: string; onSend: (ops: Op[]) => void; onClose: () => void; meeting?: WbMeeting }) {
  useEffect(() => {
    document.title = 'Whiteboard (students see it live)';
  }, []);
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex' }}>
      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        <WhiteboardBoard session={session} mode="edit" identity={identity} onSend={onSend} onClose={onClose} hideStop={!!meeting} style={{ position: 'absolute', inset: 0 }} />
      </div>
      {meeting ? <MeetingBar meeting={meeting} onStop={onClose} /> : null}
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
(window as unknown as { __board: unknown }).__board = {
  mount(session: WhiteboardSession, identity: string, onSend: (ops: Op[]) => void, onClose: () => void, meeting?: WbMeeting) {
    root.render(<App session={session} identity={identity} onSend={onSend} onClose={onClose} meeting={meeting} />);
  },
};

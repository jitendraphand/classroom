import { createRoot } from 'react-dom/client';
import { WhiteboardBoard } from '../shared/web/whiteboard/WhiteboardBoard';
import type { WhiteboardSession } from '../shared/web/whiteboard/session';
import type { Op } from '../shared/web/whiteboard/model';

/** Whiteboard window: the class window hands over its session (same renderer process). */
const root = createRoot(document.getElementById('root')!);
(window as unknown as { __board: unknown }).__board = {
  mount(session: WhiteboardSession, identity: string, onSend: (ops: Op[]) => void, onClose: () => void) {
    root.render(<WhiteboardBoard session={session} mode="edit" identity={identity} onSend={onSend} onClose={onClose} style={{ position: 'fixed', inset: 0 }} />);
  },
};

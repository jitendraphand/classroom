/**
 * Waiting-room rules. `shouldAutoAdmit` and `idsToAdmitOnToggle` match
 * apps/web/src/lib/admissionLogic.ts. The reducer is the client-side view of
 * the same rules (Admit, Admit all, switch).
 */

export type AdmissionRoom = { status: string; waitingRoomOn: boolean };
export type AdmissionParticipant = { role: string; status: string };

/** Should this participant be admitted straight away (no waiting room)? */
export function shouldAutoAdmit(room: AdmissionRoom, p: AdmissionParticipant): boolean {
  return room.status !== 'ENDED' && !room.waitingRoomOn && p.role === 'STUDENT' && p.status === 'WAITING';
}

/** Turning the waiting room off admits everyone currently waiting; turning it on admits nobody. */
export function idsToAdmitOnToggle(
  waitingRoomOn: boolean,
  waiting: { id: string; role: string; status: string }[]
): string[] {
  if (waitingRoomOn) return [];
  return waiting.filter((p) => p.role === 'STUDENT' && p.status === 'WAITING').map((p) => p.id);
}

export type WaitingStudent = {
  id: string;
  displayName: string;
  createdAt?: string | number | null;
};

export type WaitingRoomState = {
  /** Server flag. On: teacher admits. Off: arrivals are admitted immediately, still muted. */
  on: boolean;
  waiting: WaitingStudent[];
  admittedIds: string[];
};

export type WaitingAction =
  | { type: 'toggle'; on: boolean }
  | { type: 'admit'; id: string }
  | { type: 'admit-all' }
  | { type: 'sync'; state: WaitingRoomState };

export type WaitingResult = {
  state: WaitingRoomState;
  /** Participant ids the client must POST to /admit (empty when the server already did it). */
  admitIds: string[];
};

/**
 * Apply a teacher action. Toggle-off admits every student who is waiting.
 * Toggle-on admits nobody. Admit never removes an already-admitted id and
 * never admits someone who is not waiting.
 */
export function reduceWaiting(state: WaitingRoomState, action: WaitingAction): WaitingResult {
  if (action.type === 'sync') {
    return { state: cloneState(action.state), admitIds: [] };
  }
  if (action.type === 'toggle') {
    if (action.on) return { state: { ...state, on: true, waiting: [...state.waiting] }, admitIds: [] };
    const admitIds = state.waiting.map((w) => w.id);
    return {
      state: {
        on: false,
        waiting: [],
        admittedIds: unique([...state.admittedIds, ...admitIds]),
      },
      admitIds,
    };
  }
  if (action.type === 'admit-all') {
    const admitIds = state.waiting.map((w) => w.id);
    return {
      state: {
        ...state,
        waiting: [],
        admittedIds: unique([...state.admittedIds, ...admitIds]),
      },
      admitIds,
    };
  }
  const target = state.waiting.find((w) => w.id === action.id);
  if (!target) return { state: cloneState(state), admitIds: [] };
  return {
    state: {
      ...state,
      waiting: state.waiting.filter((w) => w.id !== action.id),
      admittedIds: unique([...state.admittedIds, action.id]),
    },
    admitIds: [action.id],
  };
}

/** Oldest waiting student, matching /state order (createdAt ascending). */
export function oldestWaiting(waiting: readonly WaitingStudent[]): WaitingStudent | null {
  if (!waiting.length) return null;
  const sorted = [...waiting].sort((a, b) => createdMs(a) - createdMs(b) || a.id.localeCompare(b.id));
  return sorted[0] ?? null;
}

function createdMs(w: WaitingStudent): number {
  if (typeof w.createdAt === 'number') return w.createdAt;
  if (typeof w.createdAt === 'string') {
    const n = Date.parse(w.createdAt);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function unique(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out;
}

function cloneState(s: WaitingRoomState): WaitingRoomState {
  return { on: s.on, waiting: s.waiting.map((w) => ({ ...w })), admittedIds: [...s.admittedIds] };
}

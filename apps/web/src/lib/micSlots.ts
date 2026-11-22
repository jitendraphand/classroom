/**
 * How many student microphones may be open at once.
 * limit <= 0 means no cap (the default): every teacher unmute works as before.
 * Above the cap, the student waits. The teacher sees that queue.
 * A slot frees when the teacher mutes someone or that student closes their mic;
 * the oldest teacher-approved waiter is then granted the slot.
 */

export type MicWaiter = { id: string; source: 'teacher' | 'student' };

export type MicBook = {
  open: string[];
  queue: MicWaiter[];
  /**
   * Granted slots whose student has not turned the mic on yet: id -> grant
   * time (ms). Kept by updateMicBook (syncPending); the idle sweep frees a
   * slot still pending after MIC_IDLE_MS.
   */
  pending?: Record<string, number>;
};

/** A granted slot is freed when the student has not turned the mic on within this time. */
export const MIC_IDLE_MS = 60_000;

export function normalizeMicLimit(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : 0;
  if (v <= 0) return 0;
  return Math.min(500, v);
}

function without(ids: string[], id: string) {
  return ids.filter((x) => x !== id);
}

/** Teacher turns a student's mic permission on or off. */
export function teacherSetMic(book: MicBook, participantId: string, muted: boolean, limit: number): MicBook & { granted: boolean; waiting: boolean } {
  const cap = normalizeMicLimit(limit);
  let open = without(book.open, participantId);
  let queue = book.queue.filter((w) => w.id !== participantId);
  if (muted || cap === 0) {
    if (!muted) open = [...open, participantId];
    const next = cap === 0 ? { open, queue } : promote(open, queue, cap);
    return { ...next, granted: !muted, waiting: false };
  }
  if (open.length < cap) {
    open = [...open, participantId];
    return { open, queue, granted: true, waiting: false };
  }
  queue = [...queue, { id: participantId, source: 'teacher' }];
  return { open, queue, granted: false, waiting: true };
}

/** Student asks to speak, or releases a slot they hold. */
export function studentSetMic(book: MicBook, participantId: string, want: boolean, limit: number): MicBook & { granted: boolean; waiting: boolean; position: number | null } {
  const cap = normalizeMicLimit(limit);
  if (cap === 0) {
    return { ...book, granted: want, waiting: false, position: null };
  }
  if (!want) {
    const open = without(book.open, participantId);
    const queue = book.queue.filter((w) => w.id !== participantId);
    return { ...promote(open, queue, cap), granted: false, waiting: false, position: null };
  }
  if (book.open.includes(participantId)) {
    return { ...book, granted: true, waiting: false, position: null };
  }
  // Asking does not open a mic. The teacher grants it, or a freed slot
  // promotes a teacher-approved waiter (see promote). A free seat is not enough.
  const queue = book.queue.some((w) => w.id === participantId)
    ? book.queue
    : [...book.queue, { id: participantId, source: 'student' as const }];
  const position = queue.findIndex((w) => w.id === participantId) + 1;
  return { open: book.open, queue, granted: false, waiting: true, position };
}

/** When a slot frees, grant it to the oldest waiter the teacher already approved. */
export function promote(open: string[], queue: MicWaiter[], limit: number): MicBook & { promoted: string | null } {
  const cap = normalizeMicLimit(limit);
  if (cap === 0) return { open, queue, promoted: null };
  const idx = queue.findIndex((w) => w.source === 'teacher');
  if (idx < 0 || open.length >= cap) return { open, queue, promoted: null };
  const waiter = queue[idx]!;
  return {
    open: [...open, waiter.id],
    queue: queue.filter((_, i) => i !== idx),
    promoted: waiter.id,
  };
}

export function queuePosition(queue: MicWaiter[], id: string): number | null {
  const i = queue.findIndex((w) => w.id === id);
  return i < 0 ? null : i + 1;
}

/**
 * Grant times for the new book: a newly opened slot starts pending now; a slot
 * that was already open keeps its pending time (or stays confirmed); closed
 * slots drop out. When the caller sets `next.pending` it decides for slots
 * that were already open (the idle sweep uses this to confirm a slot).
 */
export function syncPending(prev: MicBook, next: MicBook, now: number): Record<string, number> {
  const was = new Set(prev.open);
  const from = next.pending ?? prev.pending ?? {};
  const out: Record<string, number> = {};
  for (const id of next.open) {
    if (!was.has(id)) out[id] = now;
    else if (from[id] != null) out[id] = from[id]!;
  }
  return out;
}

/** Pending slots older than MIC_IDLE_MS (candidates for the idle sweep). */
export function idlePending(book: MicBook, now: number, idleMs = MIC_IDLE_MS): string[] {
  return Object.entries(book.pending ?? {})
    .filter(([id, at]) => book.open.includes(id) && now - at >= idleMs)
    .map(([id]) => id);
}

/**
 * Rebuild the book when the admin changes the limit, from the students who
 * are actually unmuted right now (`unmuted`, admitted students only, in join
 * order) and the admitted students (`present`).
 *
 * Fair rule: whoever got the floor first keeps it. Students already holding a
 * slot keep their order; students unmuted while there was no limit follow in
 * join order. Anyone past the new limit (the most recent) is muted and put at
 * the FRONT of the queue as teacher-approved, so they get the next free slots
 * back in that order. When the limit is raised, teacher-approved waiters are
 * promoted into the new slots. Limit 0 (no cap): the book is cleared and every
 * teacher-approved waiter is unmuted; students who only asked stay muted.
 */
export function rebuildForLimit(
  book: MicBook,
  unmuted: string[],
  present: string[],
  limit: number
): { next: MicBook; mute: string[]; unmute: string[] } {
  const cap = normalizeMicLimit(limit);
  const here = new Set(present);
  const on = new Set(unmuted);
  const queue0 = book.queue.filter((w) => here.has(w.id) && !on.has(w.id));
  if (cap === 0) {
    return { next: { open: [], queue: [] }, mute: [], unmute: queue0.filter((w) => w.source === 'teacher').map((w) => w.id) };
  }
  const ordered = [...book.open.filter((id) => on.has(id)), ...unmuted.filter((id) => !book.open.includes(id))];
  const open = ordered.slice(0, cap);
  const over = ordered.slice(cap);
  const queue: MicWaiter[] = [...over.map((id) => ({ id, source: 'teacher' as const })), ...queue0];
  const unmute: string[] = [];
  while (open.length < cap) {
    const i = queue.findIndex((w) => w.source === 'teacher');
    if (i < 0) break;
    const w = queue.splice(i, 1)[0]!;
    open.push(w.id);
    unmute.push(w.id);
  }
  return { next: { open, queue }, mute: over, unmute };
}

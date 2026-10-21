/**
 * How many student microphones may be open at once.
 * limit <= 0 means no cap (the default): every teacher unmute works as before.
 * Above the cap, the student waits. The teacher sees that queue.
 * A slot frees when the teacher mutes someone or that student closes their mic;
 * the oldest teacher-approved waiter is then granted the slot.
 */

export type MicWaiter = { id: string; source: 'teacher' | 'student' };

export type MicBook = { open: string[]; queue: MicWaiter[] };

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

/**
 * Typing and fullscreen on iPad (Nov 27). iPadOS Safari refuses keyboard
 * input in a fullscreen page ("Typing is not allowed in full-screen
 * websites"; Apple Pencil handwriting counts as typing). So on an iPad /
 * iPhone, when a text field (chat, roster search, the whiteboard text tool)
 * gets focus, the class leaves fullscreen first and calls that a "typing
 * hold": no auto re-entry on that tap, no "left fullscreen" alert, no
 * blocking cover. When typing ends (focus leaves every text field, plus a
 * short tail) the hold ends and the next tap brings fullscreen back.
 *
 * Elsewhere (desktop, Android) typing in fullscreen works: nothing changes.
 */

/** A text field: input (text-like), textarea, or contenteditable. */
export function isEditableTarget(el: unknown): boolean {
  if (!el || typeof el !== 'object') return false;
  const e = el as { tagName?: string; type?: string; isContentEditable?: boolean };
  if (e.isContentEditable) return true;
  const tag = (e.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  const type = (e.type || 'text').toLowerCase();
  return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'hidden'].includes(type);
}

/** After the last text field loses focus, the hold lasts this much longer (keyboard closing, a Send tap). */
export const TYPING_TAIL_MS = 800;

export type TypingHold = {
  active(): boolean;
  subscribe(fn: () => void): () => void;
  /** Focus moved into a text field. */
  start(): void;
  /** Focus left every text field. */
  stop(): void;
};

export function createTypingHold(opts: { tailMs?: number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void } = {}): TypingHold {
  const tailMs = opts.tailMs ?? TYPING_TAIL_MS;
  const setT = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let typing = false;
  let tail: unknown = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((fn) => fn());
  return {
    active: () => typing || tail !== null,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start() {
      const was = typing || tail !== null;
      if (tail !== null) {
        clearT(tail);
        tail = null;
      }
      typing = true;
      if (!was) emit();
    },
    stop() {
      if (!typing) return;
      typing = false;
      tail = setT(() => {
        tail = null;
        emit();
      }, tailMs);
    },
  };
}

export const typingHold = createTypingHold();

/**
 * Watch focus on an iPad / iPhone: entering a text field starts the hold and
 * calls `leaveFullscreen` (before the keyboard opens); leaving all text fields
 * stops it. Returns the cleanup.
 */
export function installTypingGuard(doc: Document, leaveFullscreen: () => void): () => void {
  const onIn = (e: FocusEvent) => {
    if (!isEditableTarget(e.target)) return;
    typingHold.start();
    leaveFullscreen();
  };
  const onOut = () => {
    // Focus may move straight to another text field: check after it settles.
    setTimeout(() => {
      if (!isEditableTarget(doc.activeElement)) typingHold.stop();
    }, 0);
  };
  doc.addEventListener('focusin', onIn);
  doc.addEventListener('focusout', onOut);
  return () => {
    doc.removeEventListener('focusin', onIn);
    doc.removeEventListener('focusout', onOut);
  };
}

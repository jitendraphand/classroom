/**
 * Single-session wording and the "Use this device instead" decision.
 * Copy matches apps/web/src/lib/sessionClient.ts.
 */

export type EndedReason = 'signed_in_elsewhere' | 'revoked' | 'disabled' | 'expired' | 'signed_out';

const REASONS: readonly EndedReason[] = ['signed_in_elsewhere', 'revoked', 'disabled', 'expired', 'signed_out'];

export function isEndedReason(v: unknown): v is EndedReason {
  return typeof v === 'string' && (REASONS as readonly string[]).includes(v);
}

export function endedSessionCopy(reason: EndedReason): { title: string; body: string } {
  switch (reason) {
    case 'signed_in_elsewhere':
      return {
        title: 'You were signed in on another device',
        body: 'Your account was just signed in on another device or browser, so it was signed out here. Only one device can be signed in at a time.',
      };
    case 'revoked':
      return {
        title: 'Your password was changed',
        body: 'Your password was changed or reset, so every device was signed out. Sign in again with the new password.',
      };
    case 'disabled':
      return {
        title: 'Your account was disabled',
        body: 'This account has been disabled. Contact the school administrator.',
      };
    case 'signed_out':
      return { title: 'You were signed out', body: 'This account was signed out. Sign in again to continue.' };
    case 'expired':
    default:
      return { title: 'Please sign in again', body: 'For security, sign in again to continue.' };
  }
}

/**
 * What "Use this device instead" should do.
 * - 'session' or a dead cookie: sign in again (login replaces the other device).
 * - LiveKit duplicate / participant-removed while this cookie is still the
 *   teacher session: reconnect and take the identity back. No second login,
 *   or the two devices would keep replacing the session.
 */
export function decideHandoff(input: {
  kind: 'device' | 'session';
  role: string | null;
  reason: string | null;
}): 'login' | 'reconnect' {
  if (input.kind === 'session') return 'login';
  if (isEndedReason(input.reason)) return 'login';
  if (input.role !== 'teacher') return 'login';
  return 'reconnect';
}

export type AttentionEvent =
  | { type: 'waiting'; name: string }
  | { type: 'hand'; name: string }
  | { type: 'message'; name: string; text: string }
  | { type: 'focus'; name: string; label: string };

export type AttentionPerson = {
  id: string;
  displayName: string;
  handRaised?: boolean;
  focus?: string | null;
};

export type AttentionMessage = {
  id: string;
  senderParticipantId: string;
  senderName: string;
  body: string;
};

/**
 * New things the tray should toast. Compares two snapshots by id, so a poll
 * that returns the same roster does not notify again.
 */
export function attentionEvents(input: {
  prevWaiting: readonly AttentionPerson[];
  nextWaiting: readonly AttentionPerson[];
  prevStudents: readonly AttentionPerson[];
  nextStudents: readonly AttentionPerson[];
  prevMessages: readonly AttentionMessage[];
  nextMessages: readonly AttentionMessage[];
  myParticipantId: string | null;
}): AttentionEvent[] {
  const out: AttentionEvent[] = [];
  const prevWait = new Set(input.prevWaiting.map((p) => p.id));
  for (const p of input.nextWaiting) {
    if (!prevWait.has(p.id)) out.push({ type: 'waiting', name: p.displayName });
  }
  const prevHands = new Set(input.prevStudents.filter((p) => p.handRaised).map((p) => p.id));
  for (const p of input.nextStudents) {
    if (p.handRaised && !prevHands.has(p.id)) out.push({ type: 'hand', name: p.displayName });
  }
  const prevFocus = new Set(input.prevStudents.filter((p) => isFocusAlert(p.focus)).map((p) => p.id));
  for (const p of input.nextStudents) {
    if (isFocusAlert(p.focus) && !prevFocus.has(p.id)) {
      out.push({ type: 'focus', name: p.displayName, label: focusLabel(p.focus) ?? 'Not in fullscreen' });
    }
  }
  const prevMsg = new Set(input.prevMessages.map((m) => m.id));
  for (const m of input.nextMessages) {
    if (prevMsg.has(m.id)) continue;
    if (input.myParticipantId && m.senderParticipantId === input.myParticipantId) continue;
    out.push({ type: 'message', name: m.senderName, text: m.body });
  }
  return out;
}

export function isFocusAlert(status: string | null | undefined): boolean {
  return status === 'left' || status === 'away';
}

export function focusLabel(status: string | null | undefined, iphone = false): string | null {
  if (status === 'left') return 'Left fullscreen';
  if (status === 'away') return 'Switched away';
  if (status === 'unsupported') return iphone ? 'iPhone — fullscreen not supported' : 'Fullscreen not supported';
  return null;
}

export function countFocusAlerts(list: readonly { focus?: string | null }[]): number {
  return list.reduce((n, p) => n + (isFocusAlert(p.focus) ? 1 : 0), 0);
}

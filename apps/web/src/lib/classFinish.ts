/**
 * Why a student's class view stopped for good (pure, shared). After any of
 * these the client disconnects LiveKit, stops every poll/timer/listener/track,
 * tries window.close(), and otherwise shows a static screen that makes no
 * network requests.
 */
export type FinishReason = 'left' | 'ended' | 'removed' | 'replaced';

export function finishFromState(
  s: { status?: string; ended?: boolean; public?: boolean; replaced?: boolean; meLeft?: boolean } | null | undefined
): FinishReason | null {
  if (!s) return null;
  if (s.replaced) return 'replaced';
  if (s.status === 'ENDED' || s.ended) return 'ended';
  if (s.public && s.meLeft) return 'removed';
  return null;
}

export function finishCopy(r: FinishReason): { title: string; body: string } {
  switch (r) {
    case 'replaced':
      return { title: 'You joined from another device', body: 'This class is open on your other device, so this one was disconnected. You can close this tab.' };
    case 'removed':
      return { title: 'You were removed from the class', body: 'Your teacher removed you from this class. You can close this tab.' };
    case 'left':
      return { title: 'You left the class', body: 'You can close this tab.' };
    default:
      return { title: 'Class ended', body: 'Your teacher has ended this class. You can close this tab.' };
  }
}

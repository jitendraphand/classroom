/**
 * Audio routing rules (echo audit, 2026-10-16). Pure, unit-tested.
 *
 * Echo root cause: a "system / computer sound" capture of the teacher's whole
 * screen records everything the teacher's speakers play, including the
 * classroom's own playback of students' voices. That capture is published to
 * every student, so each student heard themselves (and the others) again
 * about half a second later, repeatedly. The fix: never send system audio
 * that can contain this app's own output.
 */

/** Teacher mic: browser echo cancellation, noise suppression and AGC always on. */
export const MIC_CAPTURE = { echoCancellation: true, noiseSuppression: true, autoGainControl: true } as const;

export type ShareSurface = 'monitor' | 'window' | 'browser' | '' | string;

/**
 * Keep a display-media audio track? Tab audio holds only that tab. Whole-screen
 * (system) audio is kept only when the browser confirms it excludes this
 * tab's own output (`restrictOwnAudio` applied); otherwise it would carry
 * students' voices back to them.
 */
export function keepShareAudio(surface: ShareSurface, settings: { restrictOwnAudio?: boolean } | null | undefined): boolean {
  if (surface === 'browser') return true;
  return settings?.restrictOwnAudio === true;
}

/** LiveKit proto TrackSource.MICROPHONE (livekit-protocol). */
const PROTO_MICROPHONE = 2;

/**
 * May this client publish a microphone under its current SFU grant?
 * Unknown permissions (not connected yet) count as allowed: the publish
 * itself is the check. livekit-client refuses a publish the grant does not
 * allow with no retry, so the publisher waits for the grant instead of
 * opening the mic and failing (echo audit, Nov 25).
 */
export function micPublishAllowed(perms: { canPublish?: boolean; canPublishSources?: number[] } | null | undefined): boolean {
  if (!perms) return true;
  if (perms.canPublish === false) return false;
  const src = perms.canPublishSources ?? [];
  return src.length === 0 || src.includes(PROTO_MICROPHONE);
}

/**
 * Is our own mic track still the live, published microphone? False after the
 * SFU unpublished it (grant revoked), the device ended it (another app took
 * the mic, Bluetooth switch), or a stray track replaced it: the publisher
 * then drops it and publishes a fresh one.
 */
export function ownMicCurrent(
  ours: { mediaStreamTrack?: { readyState?: string } | null } | null | undefined,
  published: unknown
): boolean {
  if (!ours) return false;
  if (published !== ours) return false;
  return ours.mediaStreamTrack?.readyState !== 'ended';
}

/** Dedupe audio playback by track sid: one element per remote audio track. */
export class AudioRegistry<E> {
  private els = new Map<string, E>();
  constructor(private create: (sid: string) => E, private dispose: (el: E, sid: string) => void) {}
  /** Subscribed: reuse the element for this sid (re-subscribe / reconnect never doubles). */
  attach(sid: string, local = false): E | null {
    if (local) return null; // never play our own mic
    const have = this.els.get(sid);
    if (have) return have;
    const el = this.create(sid);
    this.els.set(sid, el);
    return el;
  }
  detach(sid: string): void {
    const el = this.els.get(sid);
    if (!el) return;
    this.els.delete(sid);
    this.dispose(el, sid);
  }
  /** Drop everything not in `live` (after a reconnect or room switch). */
  prune(live: Iterable<string>): void {
    const keep = new Set(live);
    for (const sid of [...this.els.keys()]) if (!keep.has(sid)) this.detach(sid);
  }
  clear(): void {
    this.prune([]);
  }
  get size(): number {
    return this.els.size;
  }
  has(sid: string): boolean {
    return this.els.has(sid);
  }
}

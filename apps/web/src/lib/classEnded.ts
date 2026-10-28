/**
 * End-of-class vs "you were removed".
 *
 * Deleting the LiveKit room disconnects everyone. Under load that disconnect
 * often arrives as PARTICIPANT_REMOVED, which used to paint the kick screen
 * before the class-ended state was read. The server sends a class-ended
 * packet first; any disconnect then checks /state once (cached) and only
 * says "removed" when that probe says the student was removed and the class
 * is still live.
 */
import { finishFromState, type FinishReason } from './classFinish';

export const CLASS_ENDED_TYPE = 'class-ended';

export function isClassEndedPacket(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') return false;
  const o = msg as { v?: unknown; type?: unknown };
  return o.v === 1 && o.type === CLASS_ENDED_TYPE;
}

export type ProbeBody = {
  status?: string;
  ended?: boolean;
  public?: boolean;
  replaced?: boolean;
  meLeft?: boolean;
} | null;

export type DisconnectVerdict = 'ended' | 'removed' | 'replaced' | 'rejoin' | 'ignore';

/**
 * Decide after one session probe. `removed` only when the probe itself says
 * the student was removed from a class that is still going. Room deletion
 * and a failed probe are never a kick.
 */
export function verdictFromProbe(opts: {
  httpStatus: number;
  body: ProbeBody;
  roomDeleted: boolean;
  participantRemoved: boolean;
  sawClassEnded: boolean;
  leaving: boolean;
}): DisconnectVerdict {
  if (opts.leaving) return 'ignore';
  if (opts.sawClassEnded || opts.httpStatus === 410) return 'ended';
  const fromState = finishFromState(opts.body);
  if (fromState === 'ended' || fromState === 'left') return 'ended';
  if (fromState === 'replaced') return 'replaced';
  if (fromState === 'removed') return 'removed';
  // Probe failed (network / 5xx) while the SFU room is already gone: the
  // only thing that deletes the room is ending the class.
  if (opts.roomDeleted && (opts.httpStatus === 0 || opts.httpStatus >= 500)) return 'ended';
  // Still live, or we could not read state. Do not call that a removal.
  void opts.participantRemoved;
  return 'rejoin';
}

/** A later "class ended" corrects a premature "removed". Leave / replaced stick. */
export function preferFinish(prev: FinishReason | null, next: FinishReason): FinishReason {
  if (prev == null) return next;
  if (prev === 'removed' && next === 'ended') return 'ended';
  return prev;
}

export type ProbeHit<T> = { at: number; value: T };

export function readProbeCache<T>(
  cache: Map<string, ProbeHit<T>>,
  key: string,
  now: number,
  ttlMs: number
): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (now - hit.at > ttlMs) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

/** One load per key while a call is in flight, then the result is reused until `ttlMs`. */
export async function onceCached<T>(opts: {
  key: string;
  now: number;
  ttlMs: number;
  cache: Map<string, ProbeHit<T>>;
  inflight: Map<string, Promise<T>>;
  load: () => Promise<T>;
  stamp?: () => number;
}): Promise<T> {
  const hit = readProbeCache(opts.cache, opts.key, opts.now, opts.ttlMs);
  if (hit !== undefined) return hit;
  const pending = opts.inflight.get(opts.key);
  if (pending) return pending;
  const p = opts
    .load()
    .then((value) => {
      opts.cache.set(opts.key, { at: (opts.stamp ?? Date.now)(), value });
      return value;
    })
    .finally(() => {
      if (opts.inflight.get(opts.key) === p) opts.inflight.delete(opts.key);
    });
  opts.inflight.set(opts.key, p);
  return p;
}

const noted = new Map<string, number>();

export function noteClassEnded(code: string, now = Date.now()) {
  if (!code) return;
  noted.set(code.toUpperCase(), now);
  // Bounded: notes older than the longest TTL callers use are useless.
  if (noted.size > 500) {
    for (const [k, at] of noted) if (now - at > 10 * 60_000) noted.delete(k);
    while (noted.size > 2000) noted.delete(noted.keys().next().value as string);
  }
}

export function classEndedNoted(code: string, now = Date.now(), ttlMs = 120_000): boolean {
  const at = noted.get((code || '').toUpperCase());
  return at != null && now - at <= ttlMs;
}

export function clearClassEndedNotes() {
  noted.clear();
}

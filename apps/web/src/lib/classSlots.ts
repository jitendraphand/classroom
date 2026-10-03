/**
 * Who gets the limited student-video slots, and in which order the teacher's
 * roster lists students. Pure, so both rules are unit-tested
 * (tests/classSlots.test.ts) and shared by the server sample, the web class
 * panel and (mirrored) the Android teacher app.
 *
 * Slot priority, server and client alike:
 *   1. students the teacher pinned (oldest pin first),
 *   2. unmuted speakers (sticky until muted),
 *   3. everyone else in rotation.
 * Pins count toward the cap; the cap is never exceeded.
 */

export type PinnedStudent = { identity: string; pinnedAt: number };

/** Teacher pins present in `identities`, oldest first, at most `max`. */
export function orderedPins(pins: PinnedStudent[], identities: Iterable<string>, max: number): string[] {
  const present = new Set(identities);
  return [...pins]
    .filter((p) => present.has(p.identity))
    .sort((a, b) => a.pinnedAt - b.pinnedAt || a.identity.localeCompare(b.identity))
    .slice(0, Math.max(0, max))
    .map((p) => p.identity);
}

/**
 * Server: the visible sample (who may publish camera this rotation).
 * `shuffle` is injected so tests are deterministic.
 */
export function allocateSample(input: {
  identities: string[];
  teacherPins: PinnedStudent[];
  speakerPins: Iterable<string>;
  max: number;
  shuffle?: <T>(a: T[]) => T[];
}): string[] {
  const max = Math.max(0, Math.floor(input.max));
  const shuffle = input.shuffle ?? (<T,>(a: T[]) => a);
  const pinned = orderedPins(input.teacherPins, input.identities, max);
  const taken = new Set(pinned);
  const speakers = new Set(input.speakerPins);
  const speakerIds = shuffle(input.identities.filter((id) => speakers.has(id) && !taken.has(id)));
  const out = [...pinned];
  for (const id of speakerIds) {
    if (out.length >= max) break;
    out.push(id);
    taken.add(id);
  }
  const rest = shuffle(input.identities.filter((id) => !taken.has(id)));
  for (const id of rest) {
    if (out.length >= max) break;
    out.push(id);
  }
  return out;
}

/**
 * Client (teacher class panel / Android video column): which students fill
 * the `studentSlots` tiles. `pool` = students actually publishing a camera;
 * `rotation` = the current rotation order of everyone else.
 */
export function pickTiles(input: {
  pool: string[];
  teacherPins: string[];
  speakingId?: string | null;
  sticky?: Iterable<string>;
  rotation: string[];
  studentSlots: number;
}): string[] {
  const slots = Math.max(0, input.studentSlots);
  const inPool = new Set(input.pool);
  const out: string[] = [];
  const push = (id: string) => {
    if (out.length < slots && inPool.has(id) && !out.includes(id)) out.push(id);
  };
  for (const id of input.teacherPins) push(id);
  if (input.speakingId) push(input.speakingId);
  for (const id of input.sticky ?? []) push(id);
  for (const id of input.rotation) push(id);
  // Anyone publishing who is not in the rotation list yet.
  for (const id of input.pool) push(id);
  return out;
}

export type RosterPerson = {
  id: string;
  displayName: string;
  role: string;
  handRaised?: boolean;
  /** ms epoch when the hand went up (unknown for hands raised before this field existed). */
  handRaisedAt?: number | null;
};

/**
 * Roster order: raised hands first, earliest raise first (unknown times after
 * known ones), then the teacher, then everyone else by name.
 */
export function sortRoster<T extends RosterPerson>(people: T[]): T[] {
  const raised = (p: T) => p.role === 'STUDENT' && !!p.handRaised;
  return [...people].sort((a, b) => {
    const ah = raised(a);
    const bh = raised(b);
    if (ah !== bh) return ah ? -1 : 1;
    if (ah && bh) {
      const at = a.handRaisedAt ?? Number.POSITIVE_INFINITY;
      const bt = b.handRaisedAt ?? Number.POSITIVE_INFINITY;
      if (at !== bt) return at < bt ? -1 : 1;
    }
    if (a.role !== b.role) return a.role === 'TEACHER' ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });
}

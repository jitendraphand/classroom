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
  /** Drawing on the share now / asked to draw (and when). */
  drawing?: boolean;
  drawRequested?: boolean;
  drawRequestedAt?: number | null;
};

/**
 * Roster order: the student drawing on the share, then draw requests
 * (earliest first), then raised hands (earliest first, unknown times after
 * known ones), then the teacher, then everyone else by name.
 */
export function sortRoster<T extends RosterPerson>(people: T[]): T[] {
  const raised = (p: T) => p.role === 'STUDENT' && !!p.handRaised;
  const drawRank = (p: T) => (p.role !== 'STUDENT' ? 2 : p.drawing ? 0 : p.drawRequested ? 1 : 2);
  return [...people].sort((a, b) => {
    const ad = drawRank(a);
    const bd = drawRank(b);
    if (ad !== bd) return ad - bd;
    if (ad === 1) {
      const at = a.drawRequestedAt ?? Number.POSITIVE_INFINITY;
      const bt = b.drawRequestedAt ?? Number.POSITIVE_INFINITY;
      if (at !== bt) return at < bt ? -1 : 1;
    }
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

/**
 * Teacher Class panel: the 2 / 4 / 6 buttons count TILES IN THE PANEL,
 * INCLUDING THE TEACHER'S OWN TILE. So "6" = you + 5 student cameras, and the
 * room's student cap (Room.maxVisibleVideos) is always `slots - 1`. The header
 * "X/Y videos shown" uses the same unit (Y = slots, X = you + students
 * actually on screen), so pressing 6 reads ".../6".
 */
export type PanelSlots = 2 | 4 | 6;

/** Pure: the panel size for a room's student cap (dashboard value), rounded down. */
export function panelSlotsForCap(studentCap: number): PanelSlots {
  const tiles = Math.floor(Number.isFinite(studentCap) ? studentCap : 5) + 1;
  if (tiles >= 6) return 6;
  if (tiles >= 4) return 4;
  return 2;
}

/** Pure: student cap that matches a panel size. */
export function studentCapForSlots(slots: PanelSlots): number {
  return slots - 1;
}

/** Pure: header numbers for "X/Y videos shown" (both include the teacher tile). */
export function videosShown(visibleStudents: number, slots: PanelSlots): { shown: number; total: number } {
  const students = Math.max(0, Math.min(visibleStudents, slots - 1));
  return { shown: students + 1, total: slots };
}

/** Pure: teacher tab title with raised hands / unread chat, e.g. "(✋2 · 3 new) Classroom". */
export function teacherTabTitle(base: string, hands: number, unread: number): string {
  const parts: string[] = [];
  if (hands > 0) parts.push(`✋${hands}`);
  if (unread > 0) parts.push(`${unread > 9 ? '9+' : unread} new`);
  return parts.length ? `(${parts.join(' · ')}) ${base}` : base;
}

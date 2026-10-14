/**
 * Teacher video slots and roster order. Mirrors apps/web/src/lib/classSlots.ts
 * so the desktop app and the server agree. Pure.
 *
 * Slot priority, server and client alike:
 *   1. students the teacher pinned (oldest pin first),
 *   2. unmuted speakers (sticky until muted),
 *   3. everyone else in rotation.
 * Pins count toward the cap; the cap is never exceeded.
 */

export type PinnedStudent = { identity: string; pinnedAt: number };

export type RosterPerson = {
  id: string;
  displayName: string;
  role: string;
  handRaised?: boolean;
  /** ms epoch when the hand went up (unknown for hands raised before this field existed). */
  handRaisedAt?: number | null;
};

/** 2 / 4 / 6 tiles on screen, including the teacher's own tile. */
export type SlotCount = 2 | 4 | 6;

const NOT_A_STUDENT = /^(adminobserver_|adminpreview_|teacher_)/;

/**
 * Students whose cameras can fill the mosaic. The server sample
 * (`visibleIdentities`) wins when it is present. Otherwise admitted
 * students, otherwise whoever already has a live camera. Teachers and
 * hidden observers never take a slot. A camera that is not live stays a
 * blank tile instead of being replaced by someone outside the sample.
 */
export function liveStudentPool(input: {
  visibleIdentities: readonly string[];
  admittedStudentIds: readonly string[];
  liveCameraIds: readonly string[];
}): string[] {
  const live = new Set(input.liveCameraIds);
  const admitted = new Set(input.admittedStudentIds);
  const usable = (id: string) =>
    !!id && !NOT_A_STUDENT.test(id) && live.has(id) && (admitted.size === 0 || admitted.has(id));
  const visible = input.visibleIdentities.filter((id) => !NOT_A_STUDENT.test(id));
  const candidates = visible.length
    ? visible
    : admitted.size
      ? input.admittedStudentIds
      : input.liveCameraIds;
  const out: string[] = [];
  for (const id of candidates) {
    if (!usable(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

export const HARD_MAX_STUDENT_VIDEOS = 6;

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
 * Client tiles: which publishing students fill the student slots.
 * `pool` = students actually publishing a camera.
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
  for (const id of input.pool) push(id);
  return out;
}

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

/** Student camera cap sent as maxVisibleVideos. 2/4/6 tiles include the teacher. */
export function studentCapForLayout(slots: SlotCount): number {
  return Math.min(HARD_MAX_STUDENT_VIDEOS, Math.max(1, slots - 1));
}

export function isSlotCount(n: number): n is SlotCount {
  return n === 2 || n === 4 || n === 6;
}

/**
 * Grid shape. The docked class view and the floating Student videos window
 * share one arrangement (peerWindowLayout): 2 → 2×1, 4 → 2×2, 6 → 3×2.
 * (The dock used to stack 2/4 as full-width strips.)
 */
export function videoGrid(slots: SlotCount, _where: 'dock' | 'share' = 'share'): { cols: number; rows: number } {
  if (slots === 2) return { cols: 2, rows: 1 };
  if (slots === 4) return { cols: 2, rows: 2 };
  return { cols: 3, rows: 2 };
}

/** First cell is the teacher (`__self__`); the rest are student identities or blank. */
export function tileCells(studentIds: readonly string[], slots: SlotCount): Array<string | null> {
  const cells: Array<string | null> = ['__self__'];
  const n = studentCapForLayout(slots);
  for (let i = 0; i < n; i++) cells.push(studentIds[i] ?? null);
  return cells;
}

/**
 * Fill the student slots: cameras first (`tiles`), then students who are in
 * the class but have no camera flowing (`noCamera`, shown with their name), up
 * to `cap`. E2E 2026-10-09: the server's visible sample can name a student
 * whose browser never publishes a camera (iPhone/iPad without one, camera
 * off); that slot used to render as an unlabeled black tile.
 */
export function fillStudentSlots(tiles: readonly string[], noCamera: readonly string[], cap: number): string[] {
  const out: string[] = [];
  for (const id of [...tiles, ...noCamera]) {
    if (out.length >= cap) break;
    if (id && !NOT_A_STUDENT.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Cells to paint: the teacher, then the filled student slots. Never blank cells. */
export function visibleCells(studentIds: readonly string[], slots: SlotCount): string[] {
  return tileCells(studentIds, slots).filter((id): id is string => id !== null);
}

function defaultShuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

/**
 * One step of the teacher mosaic. Mirrors ClassroomRoom's peer-id memo:
 * pins, active speaker, sticky speakers, then a rotation of everyone else
 * who is actually publishing. `shuffle` runs only when the rotating set
 * gains members.
 */
export function selectStudentTiles(input: {
  pool: string[];
  teacherPins: string[];
  speakingId?: string | null;
  sticky?: readonly string[];
  prevMosaic: readonly string[];
  rotationTick: number;
  lastTick: number;
  studentSlots: number;
  shuffle?: <T>(a: T[]) => T[];
}): { tiles: string[]; mosaic: string[]; lastTick: number } {
  const shuffle = input.shuffle ?? defaultShuffle;
  const pins = input.teacherPins.filter((id) => input.pool.includes(id));
  const sticky = (input.sticky ?? []).filter((id) => input.pool.includes(id));
  const speakingId = input.speakingId && input.pool.includes(input.speakingId) ? input.speakingId : null;
  const rest = input.pool.filter((id) => !pins.includes(id) && id !== speakingId && !sticky.includes(id));
  const prevMosaic = input.prevMosaic.filter((id) => rest.includes(id));
  const needSlots = Math.max(0, input.studentSlots - pins.length - sticky.length);
  const membershipChanged =
    prevMosaic.length !== rest.length || prevMosaic.some((id) => !rest.includes(id));
  let mosaic = [...prevMosaic];
  if (membershipChanged || mosaic.length === 0 || mosaic.length < Math.min(rest.length, needSlots)) {
    mosaic = shuffle([...rest]);
  }
  let lastTick = input.lastTick;
  if (lastTick !== input.rotationTick) {
    lastTick = input.rotationTick;
    const rotating = mosaic.filter((id) => rest.includes(id));
    for (const id of rest) if (!rotating.includes(id)) rotating.push(id);
    mosaic = rotating.length > 1 ? [...rotating.slice(1), rotating[0]!] : rotating;
  }
  const tiles = pickTiles({
    pool: input.pool,
    teacherPins: pins,
    speakingId,
    sticky,
    rotation: mosaic,
    studentSlots: input.studentSlots,
  });
  return { tiles, mosaic, lastTick };
}

/** Rotate the order by one (the next student moves to the front). */
export function rotateOrder(order: readonly string[]): string[] {
  return order.length > 1 ? [...order.slice(1), order[0]!] : [...order];
}

/**
 * Compact 16:9 tiles for the docked grid inside `box` (CSS px): the largest
 * tile that fits cols×rows with `gap`, centred, like the floating window.
 */
export function dockTileSize(box: { w: number; h: number }, slots: SlotCount, gap = 4): { cols: number; rows: number; tileW: number; tileH: number } {
  const { cols, rows } = videoGrid(slots);
  const availW = Math.max(0, box.w - gap * (cols - 1)) / cols;
  const availH = Math.max(0, box.h - gap * (rows - 1)) / rows;
  let tileW = Math.min(availW, (availH * 16) / 9);
  tileW = Math.max(16, Math.floor(tileW));
  const tileH = Math.max(9, Math.floor((tileW * 9) / 16));
  return { cols, rows, tileW, tileH };
}

/**
 * Admitted students still in the LiveKit room. The server's admitted list can
 * lag a departure (trial 2026-10-14: Load171/Load207 kept "camera off" tiles
 * in the Student videos rotation after they left).
 */
export function presentStudents(admitted: Iterable<string>, inRoom: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const id of admitted) if (inRoom.has(id)) out.add(id);
  return out;
}

/**
 * Student-video pages (replaces the random 8-second rotation).
 *
 * The teacher's video panel shows at most `max` student cameras (the room's
 * maxVisibleVideos, set by the panel size; never more than 6). Students whose
 * camera is on are listed in roster order (natural name order) and split into
 * pages; the teacher moves between pages with Prev / Next. Only the current
 * page's students (plus the students the teacher pinned, who keep a tile on
 * every page) may publish camera video, so cost still follows exactly what is
 * on screen: at most `max` student cameras are sent at any moment.
 *
 * Pure, unit-tested (tests/videoPages.test.ts); lib/sample.ts applies it.
 */
import { naturalCompare } from './naturalSort';
import { orderedPins, type PinnedStudent } from './classSlots';

export type PageCandidate = { identity: string; name: string; camOn: boolean };

export type VideoPageLayout = {
  /** Who may publish camera now: pins first, then this page, at most `max`. */
  visible: string[];
  /** Display order for the teacher's tiles (same as `visible`). */
  order: string[];
  /** Current page, 0-based (clamped). */
  page: number;
  /** Number of pages (at least 1). */
  pages: number;
  /** Tiles per page left after the pins. */
  pageSize: number;
  /** Camera-on students that are paged (pins not counted). */
  total: number;
};

/** Roster order for paging: natural name order, then identity (stable for equal names). */
export function pagingOrder(candidates: readonly PageCandidate[]): string[] {
  return [...candidates]
    .filter((c) => c.camOn)
    .sort((a, b) => naturalCompare(a.name, b.name) || a.identity.localeCompare(b.identity))
    .map((c) => c.identity);
}

export function videoPageLayout(input: {
  candidates: readonly PageCandidate[];
  teacherPins: PinnedStudent[];
  max: number;
  page: number;
}): VideoPageLayout {
  const max = Math.max(0, Math.floor(input.max));
  const pins = orderedPins(input.teacherPins, input.candidates.map((c) => c.identity), max);
  const pinned = new Set(pins);
  const rest = pagingOrder(input.candidates).filter((id) => !pinned.has(id));
  const pageSize = Math.max(0, max - pins.length);
  const pages = pageSize > 0 ? Math.max(1, Math.ceil(rest.length / pageSize)) : 1;
  const want = Number.isFinite(input.page) ? Math.floor(input.page) : 0;
  const page = Math.min(Math.max(0, want), pages - 1);
  const slice = pageSize > 0 ? rest.slice(page * pageSize, page * pageSize + pageSize) : [];
  const visible = [...pins, ...slice];
  return { visible, order: visible, page, pages, pageSize, total: rest.length };
}

/** Next page index for a Prev / Next press, wrapping at both ends. */
export function stepPage(page: number, pages: number, delta: number): number {
  const n = Math.max(1, Math.floor(pages));
  const p = Math.min(Math.max(0, Math.floor(page)), n - 1);
  return (((p + Math.trunc(delta)) % n) + n) % n;
}

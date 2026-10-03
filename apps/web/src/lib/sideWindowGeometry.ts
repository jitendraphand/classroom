/**
 * Placement of the share side windows (chat, roster, student videos) next to
 * the always-on-top share toolbar. Pure (unit-tested in tests/sideWindowGeometry.test.ts).
 *
 * All values are screen DIPs. The toolbar never moves; side windows line up
 * above it (or below when there is no room above), right-aligned with the
 * toolbar and stacked leftwards in a fixed order so they never overlap each
 * other or the toolbar.
 */

export type SideKind = 'chat' | 'roster' | 'videos';
export type Box = { x: number; y: number; w: number; h: number };
export type Avail = { left: number; top: number; width: number; height: number };
export type Size = { w: number; h: number };

/** Left-to-right order from the toolbar's right edge (first = rightmost). */
export const SIDE_ORDER: SideKind[] = ['chat', 'roster', 'videos'];
export const SIDE_GAP = 8;

/** Default window sizes (CSS px, outer). */
export const SIDE_SIZE: Record<SideKind, Size> = {
  chat: { w: 340, h: 420 },
  roster: { w: 340, h: 420 },
  videos: { w: 320, h: 300 },
};

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Where to open `kind`. `open` lists the side windows already open (their
 * sizes reserve their columns). Without a toolbar box (unknown position) the
 * windows go to the bottom-right of the available area.
 */
export function sideWindowBox(
  kind: SideKind,
  toolbar: Box | null,
  avail: Avail,
  sizes: Partial<Record<SideKind, Size>> = {}
): { left: number; top: number; w: number; h: number } {
  const size = (k: SideKind) => sizes[k] ?? SIDE_SIZE[k];
  const me = size(kind);
  const w = Math.min(me.w, avail.width);
  const h = Math.min(me.h, avail.height);
  // Columns to the left of the toolbar's right edge, in SIDE_ORDER.
  let offset = 0;
  for (const k of SIDE_ORDER) {
    if (k === kind) break;
    offset += size(k).w + SIDE_GAP;
  }
  const availRight = avail.left + avail.width;
  const availBottom = avail.top + avail.height;
  if (!toolbar) {
    return {
      left: clamp(availRight - SIDE_GAP - offset - w, avail.left, availRight - w),
      top: clamp(availBottom - SIDE_GAP - h, avail.top, availBottom - h),
      w,
      h,
    };
  }
  const right = toolbar.x + toolbar.w - offset;
  const roomAbove = toolbar.y - SIDE_GAP - avail.top;
  const roomBelow = availBottom - (toolbar.y + toolbar.h + SIDE_GAP);
  const top =
    roomAbove >= h || roomAbove >= roomBelow
      ? toolbar.y - SIDE_GAP - h
      : toolbar.y + toolbar.h + SIDE_GAP;
  return {
    left: clamp(right - w, avail.left, availRight - w),
    top: clamp(top, avail.top, availBottom - h),
    w,
    h,
  };
}

/** Do two boxes overlap (for tests / sanity checks)? */
export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Inner size for the share toolbar window: just its row of controls (plus
 * a panel only in the in-toolbar fallback). No minimum width beyond the
 * content, so there is no empty band to the right or below.
 */
export function toolbarInnerSize(content: { w: number; h: number }, opts: { panel: boolean }): { w: number; h: number } {
  const w = Math.ceil(Math.min(980, Math.max(96, content.w + 2)));
  const h = Math.ceil(Math.min(opts.panel ? 460 : 64, Math.max(32, content.h)));
  return { w, h };
}

/**
 * Keep a small popover (e.g. the mic options) inside the viewport. Pure, so
 * the geometry is unit-tested: prefer opening above the anchor, centred on it;
 * flip below when there is not enough room above (and more below), then shift
 * horizontally / vertically so no edge leaves the viewport. A popover taller
 * than the viewport gets a max height (it scrolls inside).
 */
export type Rect = { left: number; top: number; width: number; height: number };

export type PopoverPlacement = {
  /** Viewport coordinates of the popover's top-left corner. */
  left: number;
  top: number;
  side: 'above' | 'below';
  /** Set when the popover must scroll to fit. */
  maxHeight: number | null;
};

export function placePopover(input: {
  anchor: Rect;
  size: { width: number; height: number };
  viewport: { width: number; height: number };
  gap?: number;
  margin?: number;
}): PopoverPlacement {
  const { anchor, viewport } = input;
  const gap = input.gap ?? 8;
  const margin = input.margin ?? 8;
  const maxH = Math.max(0, viewport.height - 2 * margin);
  const width = Math.min(input.size.width, Math.max(0, viewport.width - 2 * margin));
  const height = Math.min(input.size.height, maxH);

  const roomAbove = anchor.top - gap - margin;
  const roomBelow = viewport.height - (anchor.top + anchor.height) - gap - margin;
  const side: 'above' | 'below' = roomAbove >= height || roomAbove >= roomBelow ? 'above' : 'below';
  let top = side === 'above' ? anchor.top - gap - height : anchor.top + anchor.height + gap;
  top = clamp(top, margin, viewport.height - margin - height);

  let left = anchor.left + anchor.width / 2 - width / 2;
  left = clamp(left, margin, viewport.width - margin - width);

  return { left, top, side, maxHeight: input.size.height > maxH ? maxH : null };
}

function clamp(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.min(Math.max(v, lo), hi);
}

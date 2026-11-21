/**
 * Natural, numeric-aware ordering for names and labels shown to people:
 * "Student 2" before "Student 10", case- and accent-insensitive, with a
 * deterministic tie-break so equal-looking names keep a stable order.
 * Use it wherever student (or other people) lists are sorted for display.
 */
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function naturalCompare(a: string | null | undefined, b: string | null | undefined): number {
  const x = a ?? '';
  const y = b ?? '';
  return collator.compare(x, y) || (x < y ? -1 : x > y ? 1 : 0);
}

/** Copy of `items` sorted naturally by `key`. */
export function naturalSortBy<T>(items: readonly T[], key: (item: T) => string | null | undefined): T[] {
  return [...items].sort((a, b) => naturalCompare(key(a), key(b)));
}

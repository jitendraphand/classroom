/**
 * Grade dropdown order: numeric grades by number (6, 7, 8, 9, 10), then the
 * rest in their master-list order. Pure, unit-tested.
 */
export function sortGradeOptions<T extends { name: string; sortOrder?: number }>(grades: readonly T[]): T[] {
  const num = (n: string) => (/^\d+$/.test(n) ? Number(n) : null);
  return grades
    .map((g, i) => ({ g, i }))
    .sort((a, b) => {
      const x = num(a.g.name);
      const y = num(b.g.name);
      if (x !== null && y !== null) return x - y;
      if (x !== null) return -1;
      if (y !== null) return 1;
      return (a.g.sortOrder ?? 0) - (b.g.sortOrder ?? 0) || a.i - b.i;
    })
    .map(({ g }) => g);
}

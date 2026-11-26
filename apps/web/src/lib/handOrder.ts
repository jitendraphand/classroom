/**
 * Raised-hand order for the roster badges ("✋ 1" = raised first). Earliest
 * raise first; hands with an unknown time keep their list order after the
 * known ones. Pure, unit-tested.
 */
export function handOrder(people: readonly { id: string; handRaised?: boolean; handRaisedAt?: number | null }[]): Map<string, number> {
  const raised = people
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => !!p.handRaised)
    .sort((a, b) => {
      const at = a.p.handRaisedAt ?? Number.POSITIVE_INFINITY;
      const bt = b.p.handRaisedAt ?? Number.POSITIVE_INFINITY;
      return at !== bt ? (at < bt ? -1 : 1) : a.i - b.i;
    });
  return new Map(raised.map(({ p }, n) => [p.id, n + 1]));
}

/** 1 → "1st", 2 → "2nd", 3 → "3rd", 11 → "11th". */
export function ordinal(n: number): string {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

/**
 * Teacher percentile rank by star ratings, per academic year.
 *
 * Bayesian average (documented, fixed):
 *   score = (C * prior + n * mean) / (C + n)
 *   prior = 4.0 stars (a neutral-good class, so a handful of ratings cannot
 *           swing a teacher to the top or the bottom)
 *   C     = 8 (the prior weighs as much as eight real ratings)
 *
 * Minimum-ratings threshold: a teacher needs at least 5 ratings from students
 * who were present before they receive a percentile. Below that, the snapshot
 * still stores the Bayesian average and rating count, and percentile is null
 * ("not enough ratings yet").
 *
 * Percentile, among eligible teachers in that academic year:
 *   100 * (number of eligible teachers with a strictly lower score) / (N - 1)
 *   A single eligible teacher is the 100th percentile. Ties do not outrank
 *   each other, so they share a percentile.
 *
 * Only ratings from students marked present (admitted) are included.
 * Written comments are never an input.
 *
 * Snapshots are stored per teacher, academic year and week (Monday in the
 * school time zone). The in-process job writes the current week when it is
 * missing; an administrator can recompute the current week at any time.
 */

export const RANK_PRIOR = 4;
export const RANK_CONFIDENCE = 8;
export const RANK_MIN_RATINGS = 5;

export function bayesianAverage(mean: number, n: number, prior = RANK_PRIOR, c = RANK_CONFIDENCE): number {
  if (n <= 0) return prior;
  return (c * prior + n * mean) / (c + n);
}

export type RankInput = { id: string; ratings: number[] };

export type RankRow = {
  id: string;
  ratingCount: number;
  rawAvg: number | null;
  bayesianAvg: number;
  eligible: boolean;
  /** Null when under the minimum-ratings threshold. */
  percentile: number | null;
};

export function rankTeachers(inputs: RankInput[]): RankRow[] {
  const rows = inputs.map((t) => {
    const n = t.ratings.length;
    const rawAvg = n ? t.ratings.reduce((a, b) => a + b, 0) / n : null;
    const bayesianAvg = bayesianAverage(rawAvg ?? RANK_PRIOR, n);
    return {
      id: t.id,
      ratingCount: n,
      rawAvg,
      bayesianAvg,
      eligible: n >= RANK_MIN_RATINGS,
      percentile: null as number | null,
    };
  });
  const eligible = rows.filter((r) => r.eligible);
  const denom = Math.max(1, eligible.length - 1);
  for (const row of rows) {
    if (!row.eligible) continue;
    if (eligible.length === 1) {
      row.percentile = 100;
      continue;
    }
    const below = eligible.filter((o) => o.bayesianAvg < row.bayesianAvg).length;
    row.percentile = Math.round((1000 * below) / denom) / 10;
  }
  return rows;
}

/** Monday of the week containing `date` (YYYY-MM-DD). weekday 0 = Sunday. */
export function weekStartMonday(date: string, weekday: number): string {
  const delta = weekday === 0 ? 6 : weekday - 1;
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() - delta);
  return dt.toISOString().slice(0, 10);
}

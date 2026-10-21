/**
 * Admin Students free-text search: name, school student ID, or roll number.
 * Matching is case-insensitive; extra spaces around the query are ignored.
 */
export function studentSearchClause(q: string | null | undefined) {
  const s = (q ?? '').trim();
  if (!s) return undefined;
  const contains = { contains: s, mode: 'insensitive' as const };
  return {
    OR: [{ name: contains }, { externalId: contains }, { rollNumber: contains }],
  };
}

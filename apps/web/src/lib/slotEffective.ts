/**
 * Weekly slots with no From date used to generate every past weekday as
 * "Not taken / skipped". New slots default From to the creation date; legacy
 * rows with a null From are clipped at the creation date instead.
 */
export function slotStartsOn(slot: { effectiveFrom: string | null; createdOn?: string | null }): string | null {
  return slot.effectiveFrom || slot.createdOn || null;
}

/** Empty / omitted From on create → the local creation date. */
export function effectiveFromForCreate(from: string | null | undefined, createdLocalDate: string): string {
  return from || createdLocalDate;
}

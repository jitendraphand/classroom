/**
 * Unsigned join-link parameter names. Dependency-free so the Edge middleware
 * can use it to route /join?SID=… to the join handler.
 */

/** Parameter names (lower-cased) → field. Names are matched case-insensitively. */
export const FIELD_ALIASES: Record<string, keyof UnsignedFields> = {
  sid: 'sid',
  studentid: 'sid',
  firstname: 'firstName',
  lastname: 'lastName',
  grade: 'grade',
  division: 'division',
  div: 'division',
  campus: 'campus',
  roll: 'roll',
  rollno: 'roll',
  rollnumber: 'roll',
};

export type UnsignedFields = {
  sid?: string;
  firstName?: string;
  lastName?: string;
  grade?: string;
  division?: string;
  campus?: string;
  roll?: string;
};

/** Does this query look like an unsigned join (any known field present)? Used by the middleware too. */
export function hasUnsignedJoinParams(params: URLSearchParams): boolean {
  for (const k of params.keys()) if (FIELD_ALIASES[k.trim().toLowerCase()]) return true;
  return false;
}

/** Read the known fields (case-insensitive names; URLSearchParams has already URL-decoded). First value wins. */
export function readUnsignedFields(params: URLSearchParams): UnsignedFields {
  const out: UnsignedFields = {};
  for (const [k, v] of params) {
    const f = FIELD_ALIASES[k.trim().toLowerCase()];
    if (f && out[f] === undefined) out[f] = v.trim().replace(/\s+/g, ' ');
  }
  return out;
}


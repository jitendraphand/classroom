import { generatePassword, passwordProblem } from './passwords';

/**
 * Rules for creating and editing sub-administrators. The system administrator
 * (kind SYSTEM) is the only account that may call these APIs; every new or
 * updated account stays kind SUB and can never be elevated.
 */

export type SubAdminPassword =
  | { ok: true; password: string; mustChangePassword: boolean; generated: boolean }
  | { ok: false; error: string };

/**
 * A chosen password is stored as-is (the creator already knows it, so the new
 * admin is not forced to change it). An omitted password gets a generated
 * temporary one that must be changed on first sign-in.
 */
export function resolveNewSubAdminPassword(password: unknown, opts: { email?: string } = {}): SubAdminPassword {
  if (password === undefined || password === null || password === '') {
    return { ok: true, password: generatePassword(), mustChangePassword: true, generated: true };
  }
  if (typeof password !== 'string') return { ok: false, error: 'Enter a valid password' };
  const problem = passwordProblem(password, { email: opts.email });
  if (problem) return { ok: false, error: problem };
  return { ok: true, password, mustChangePassword: false, generated: false };
}

/** Every created sub-admin is SUB. Callers must not write kind SYSTEM. */
export const NEW_SUB_ADMIN_KIND = 'SUB' as const;

/** PATCH/POST bodies must not be able to change kind to SYSTEM (or anything else). */
export function rejectedKindChange(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(body, 'kind')) return null;
  const kind = (body as { kind?: unknown }).kind;
  if (kind === undefined) return null;
  if (kind !== 'SUB') return 'A sub-administrator cannot be made the system administrator';
  return null;
}

export function mutateSubAdminDenied<T extends { id: string; kind: string }>(
  row: T | null,
  opts: { actorId?: string; action: 'edit' | 'delete' }
): { ok: false; error: string; status: number } | { ok: true; row: T } {
  if (!row) return { ok: false, error: 'Administrator not found', status: 404 };
  if (row.kind !== 'SUB') {
    return {
      ok: false,
      error: opts.action === 'delete' ? 'The system administrator cannot be deleted' : 'The system administrator is not edited here',
      status: 403,
    };
  }
  if (opts.action === 'delete' && opts.actorId && row.id === opts.actorId) {
    return { ok: false, error: 'You cannot delete your own account', status: 403 };
  }
  return { ok: true, row };
}
